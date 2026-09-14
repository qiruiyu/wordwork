"""End-to-end scenarios against the real API and the real DOCX engine.

Every document here is generated in-memory by `docx()`, so no real grant
material ever reaches the repository or the test database.
"""

import hashlib
import io
import os
import re
import tempfile
import zipfile
from pathlib import Path

os.environ.setdefault("WORDWORK_DATA_DIR", tempfile.mkdtemp(prefix="wordwork-integration-"))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402
from support import CURRENT_PASSWORDS, DEMO_PASSWORD, changed_password  # noqa: E402

CONTENT_TYPES = (
    '<?xml version="1.0"?><Types '
    'xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
RD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MEMBER_PASSWORD = "member-password-2026"


def paragraph(para_id: str, runs: str) -> str:
    return f'<w:p w14:paraId="{para_id}">{runs}</w:p>'


def run(text: str, rpr: str = "") -> str:
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'


def _pack(body: str) -> bytes:
    xml = (
        '<?xml version="1.0"?>'
        f'<w:document xmlns:w="{W}" xmlns:w14="{W14}" xmlns:r="{RD}"><w:body>{body}<w:sectPr/></w:body></w:document>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("word/document.xml", xml)
    return buffer.getvalue()


def docx(*paragraphs: str) -> bytes:
    """Build a minimal, desensitised .docx whose paragraphs carry w14:paraId."""
    body = "".join(
        f'<w:p w14:paraId="{index:08X}"><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'
        for index, text in enumerate(paragraphs, start=1)
    )
    return _pack(body)


def docx_body(body: str) -> bytes:
    """Build a .docx from hand-written paragraph/table XML for structural scenarios."""
    return _pack(body)


def document_text(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        xml = archive.read("word/document.xml").decode("utf-8")
    return "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml))


def document_xml(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return archive.read("word/document.xml").decode("utf-8")


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def upload(raw: bytes, name: str = "main.docx") -> dict:
    return {"file": (name, raw, DOCX_MIME)}


def raw_login(client: TestClient, username: str, password: str) -> dict:
    """Log in without touching the mandatory password change."""
    response = client.post("/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()


def login(client: TestClient, username: str, password: str | None = None) -> str:
    """Log in, completing the forced first-login password change the way a real user must."""
    password = password or CURRENT_PASSWORDS.get(username, DEMO_PASSWORD)
    body = raw_login(client, username, password)
    token = body["access_token"]
    if not body["member"]["must_change_password"]:
        return token
    new_password = changed_password(username)
    changed = client.post(
        "/auth/change-password",
        headers=auth(token),
        json={"current_password": password, "new_password": new_password},
    )
    assert changed.status_code == 200, changed.text
    CURRENT_PASSWORDS[username] = new_password
    return token


def create_member(client: TestClient, teacher: str, project_id: int, username: str, role: str = "student") -> dict:
    response = client.post(
        f"/projects/{project_id}/members",
        headers=auth(teacher),
        json={"username": username, "password": MEMBER_PASSWORD, "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def add_member(client: TestClient, teacher: str, project_id: int, username: str, role: str = "student") -> str:
    """Create a member and take them through the mandatory first-login password change."""
    create_member(client, teacher, project_id, username, role)
    return login(client, username, MEMBER_PASSWORD)


def open_round(client: TestClient, teacher: str, name: str, paragraphs: list[str]) -> tuple[int, int, dict]:
    """Create project + initial document + published round, as the teacher would."""
    headers = auth(teacher)
    project = client.post("/projects", headers=headers, json={"name": name})
    assert project.status_code == 200, project.text
    project_id = project.json()["id"]

    document = client.post(f"/projects/{project_id}/documents", headers=headers, files=upload(docx(*paragraphs)))
    assert document.status_code == 200, document.text
    document_id = document.json()["id"]

    round_ = client.post(f"/projects/{project_id}/rounds", headers=headers, json={"document_id": document_id}).json()
    assert client.post(f"/rounds/{round_['id']}/publish", headers=headers).status_code == 200
    return project_id, document_id, round_


def submit(client: TestClient, token: str, round_id: int, base_version_id: int, raw: bytes, note: str):
    return client.post(
        f"/rounds/{round_id}/submissions",
        headers=auth(token),
        data={"base_version_id": base_version_id, "sha256": hashlib.sha256(raw).hexdigest(), "note": note},
        files=upload(raw, "submission.docx"),
    )


def review_all(client: TestClient, teacher: str, submission_id: int, decision: str = "accepted") -> dict:
    diff = client.get(f"/submissions/{submission_id}/diff", headers=auth(teacher))
    assert diff.status_code == 200, diff.text
    for hunk in diff.json()["hunks"]:
        decided = client.patch(
            f"/reviews/{submission_id}/hunks/{hunk['id']}", headers=auth(teacher), json={"decision": decision}
        )
        assert decided.status_code == 200, decided.text
    finalized = client.post(f"/reviews/{submission_id}/finalize", headers=auth(teacher))
    assert finalized.status_code == 200, finalized.text
    return diff.json()


def test_two_students_edit_different_paragraphs_then_teacher_publishes():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, document_id, round_ = open_round(
            client, teacher, "并行修改项目", ["第一段。", "第二段。", "第三段。"]
        )
        alice = add_member(client, teacher, project_id, "alice")
        bob = add_member(client, teacher, project_id, "bob")
        base_version_id = round_["base_version_id"]

        first = submit(client, alice, round_["id"], base_version_id, docx("第一段。", "第二段已由甲修改。", "第三段。"), "甲改第二段")
        second = submit(client, bob, round_["id"], base_version_id, docx("第一段。", "第二段。", "第三段已由乙修改。"), "乙改第三段")
        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        assert first.json()["status"] == "ready_for_review"
        assert first.json()["redline_version_id"], "提交后应生成带修订痕迹的版本"

        # The student can read every hunk but cannot decide any of them.
        student_hunks = client.get(f"/submissions/{first.json()['id']}/diff", headers=auth(bob))
        assert student_hunks.status_code == 200 and student_hunks.json()["hunks"]

        review_all(client, teacher, first.json()["id"])
        review_all(client, teacher, second.json()["id"])

        published = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert published.status_code == 200, published.text
        final_version_id = published.json()["version_id"]
        assert published.json()["summary_redline_version_id"]

        merged = client.get(f"/versions/{final_version_id}/download", headers=auth(teacher))
        assert merged.status_code == 200
        text = document_text(merged.content)
        assert "第二段已由甲修改。" in text, text
        assert "第三段已由乙修改。" in text, text
        assert "第一段。" in text

        assert client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json() == []

        versions = client.get(f"/documents/{document_id}/versions", headers=auth(teacher)).json()
        current = [v for v in versions if v["current"]]
        assert len(current) == 1 and current[0]["id"] == final_version_id
        assert {v["kind"] for v in versions} >= {"main", "submission", "redline", "contribution"}

        # The teacher can roll the document back to an earlier version.
        base_version = next(v for v in versions if v["id"] == base_version_id)
        restored = client.post(
            f"/versions/{base_version['id']}/restore", headers=auth(teacher), json={"document_id": document_id}
        )
        assert restored.status_code == 200
        after = client.get(f"/documents/{document_id}/versions", headers=auth(teacher)).json()
        assert next(v for v in after if v["current"])["id"] == base_version_id


def test_same_paragraph_conflict_blocks_publish_until_teacher_chooses_a_side():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "同段落冲突项目", ["第一段。", "第二段。", "第三段。"])
        carol = add_member(client, teacher, project_id, "carol")
        dave = add_member(client, teacher, project_id, "dave")
        base_version_id = round_["base_version_id"]

        first = submit(client, carol, round_["id"], base_version_id, docx("第一段。", "第二段改成了甲的版本。", "第三段。"), "甲")
        second = submit(client, dave, round_["id"], base_version_id, docx("第一段。", "第二段改成了乙的版本。", "第三段。"), "乙")
        assert first.status_code == 200 and second.status_code == 200

        review_all(client, teacher, first.json()["id"])
        review_all(client, teacher, second.json()["id"])

        blocked = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert blocked.status_code == 409, blocked.text
        conflicts = blocked.json()["detail"]["conflicts"]
        assert len(conflicts) == 1, blocked.json()
        conflict = conflicts[0]
        assert conflict["current_author"] and conflict["incoming_author"]
        assert {conflict["current_author"], conflict["incoming_author"]} == {"carol", "dave"}
        assert "甲" in conflict["current_text"] + conflict["incoming_text"]
        anchor = conflict["match_key"]

        stored = client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json()
        assert len(stored) == 1 and stored[0]["anchor"] == anchor and stored[0]["status"] == "open"

        # A student may not resolve the conflict, not even their own side.
        assert client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(dave), json={}).status_code == 403

        resolved = client.post(
            f"/rounds/{round_['id']}/publish-result",
            headers=auth(teacher),
            json={"conflict_choices": {anchor: "dave"}},
        )
        assert resolved.status_code == 200, resolved.text
        merged = client.get(f"/versions/{resolved.json()['version_id']}/download", headers=auth(teacher))
        text = document_text(merged.content)
        assert "第二段改成了乙的版本。" in text, text
        assert "第二段改成了甲的版本。" not in text, text

        final_conflicts = client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json()
        assert final_conflicts[0]["status"] == "resolved"
        assert final_conflicts[0]["resolution"] == "dave"


def test_unresolvable_conflict_can_be_replaced_by_a_teacher_uploaded_manual_merge():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, document_id, round_ = open_round(client, teacher, "人工合并项目", ["第一段。", "第二段。", "第三段。"])
        erin = add_member(client, teacher, project_id, "erin")
        frank = add_member(client, teacher, project_id, "frank")
        base_version_id = round_["base_version_id"]

        first = submit(client, erin, round_["id"], base_version_id, docx("第一段。", "第二段来自乙。", "第三段。"), "乙")
        second = submit(client, frank, round_["id"], base_version_id, docx("第一段。", "第二段来自丙。", "第三段。"), "丙")
        review_all(client, teacher, first.json()["id"])
        review_all(client, teacher, second.json()["id"])

        blocked = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert blocked.status_code == 409

        manual = docx("第一段。", "第二段由老师人工合并。", "第三段。")
        uploaded = client.post(
            f"/rounds/{round_['id']}/manual-result", headers=auth(teacher), files=upload(manual, "merged.docx")
        )
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["status"] == "published"
        assert uploaded.json()["resolution"] == "manual"

        current = [v for v in client.get(f"/documents/{document_id}/versions", headers=auth(teacher)).json() if v["current"]]
        assert current[0]["id"] == uploaded.json()["version_id"]
        assert current[0]["kind"] == "manual_merge"

        # A manual merge must leave the same audit trail as an automatic publish,
        # otherwise the two rounds are not comparable after the fact.
        versions = client.get(f"/documents/{document_id}/versions", headers=auth(teacher)).json()
        summary_id = uploaded.json()["summary_redline_version_id"]
        assert summary_id, uploaded.json()
        summary = next(v for v in versions if v["id"] == summary_id)
        assert summary["kind"] == "summary_redline"

        conflicts = client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json()
        assert conflicts and all(c["status"] == "resolved" and c["resolution"] == "manual" for c in conflicts)

        # The round is closed: no further submissions.
        late = submit(client, erin, round_["id"], base_version_id, docx("第一段。", "第二段再来。", "第三段。"), "再来")
        assert late.status_code == 409


def test_students_cannot_reach_teacher_or_owner_only_operations():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, document_id, round_ = open_round(client, teacher, "权限项目", ["第一段。", "第二段。"])
        student = add_member(client, teacher, project_id, "grace")
        headers = auth(student)

        assert client.post("/projects", headers=headers, json={"name": "学生自己建的项目"}).status_code == 403
        assert client.post(
            f"/projects/{project_id}/members",
            headers=headers,
            json={"username": "mole", "password": "mole-password-2026", "role": "teacher"},
        ).status_code == 403
        assert client.post(
            f"/projects/{project_id}/documents", headers=headers, files=upload(docx("入侵。"), "x.docx")
        ).status_code == 403
        assert client.post(
            f"/projects/{project_id}/rounds", headers=headers, json={"document_id": document_id}
        ).status_code == 403
        assert client.post(f"/rounds/{round_['id']}/publish", headers=headers).status_code == 403
        assert client.post(f"/rounds/{round_['id']}/publish-result", headers=headers, json={}).status_code == 403
        assert client.post(
            f"/rounds/{round_['id']}/manual-result", headers=headers, files=upload(docx("入侵。"), "x.docx")
        ).status_code == 403
        assert client.post(
            f"/versions/{round_['base_version_id']}/restore", headers=headers, json={"document_id": document_id}
        ).status_code == 403

        submission = submit(client, student, round_["id"], round_["base_version_id"], docx("第一段改。", "第二段。"), "我的修改")
        assert submission.status_code == 200
        submission_id = submission.json()["id"]
        hunks = client.get(f"/submissions/{submission_id}/diff", headers=headers).json()["hunks"]
        assert hunks
        assert client.patch(
            f"/reviews/{submission_id}/hunks/{hunks[0]['id']}", headers=headers, json={"decision": "accepted"}
        ).status_code == 403
        assert client.post(f"/reviews/{submission_id}/finalize", headers=headers).status_code == 403

        # A teacher who never joined the project sees nothing, exactly like a stranger.
        other_project = client.post("/projects", headers=auth(teacher), json={"name": "另一个老师的项目"}).json()["id"]
        outsider = add_member(client, teacher, other_project, "teacher_outsider", role="teacher")
        assert client.get(f"/projects/{project_id}", headers=auth(outsider)).status_code == 403
        assert client.get(f"/rounds/{round_['id']}", headers=auth(outsider)).status_code == 403
        assert client.get(f"/documents/{document_id}/versions", headers=auth(outsider)).status_code == 403
        assert client.post(
            f"/projects/{project_id}/members",
            headers=auth(outsider),
            json={"username": "mole2", "password": "mole-password-2026", "role": "student"},
        ).status_code == 403
        assert [p["id"] for p in client.get("/projects", headers=auth(outsider)).json()] == [other_project]


def test_sessions_persist_are_revocable_and_expire_on_demand():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, _ = open_round(client, teacher, "会话项目", ["第一段。"])
        token = add_member(client, teacher, project_id, "heidi")

        assert client.get("/me", headers=auth(token)).json()["username"] == "heidi"
        assert client.post("/auth/logout", headers=auth(token)).status_code == 200
        assert client.get("/me", headers=auth(token)).status_code == 401
        assert client.get("/me", headers={"Authorization": "Bearer not-a-real-token"}).status_code == 401
        assert client.get("/me").status_code == 401


def test_first_login_password_change_is_enforced_before_any_other_call():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "改密项目", ["第一段。"])
        created = create_member(client, teacher, project_id, "ivan")
        assert created["must_change_password"] is True, "新账号必须被标记为需要改密"

        token = raw_login(client, "ivan", MEMBER_PASSWORD)["access_token"]
        second_token = raw_login(client, "ivan", MEMBER_PASSWORD)["access_token"]
        assert client.get("/me", headers=auth(token)).json()["must_change_password"] is True

        # Until the password is actually replaced, everything but /me, /auth/logout and
        # /auth/change-password is refused — the initial password was spoken aloud.
        assert client.get("/projects", headers=auth(token)).status_code == 428
        assert client.get(f"/projects/{project_id}", headers=auth(token)).status_code == 428
        assert client.get(f"/rounds/{round_['id']}", headers=auth(token)).status_code == 428
        assert client.get("/events", headers=auth(token)).status_code == 428

        wrong = client.post(
            "/auth/change-password",
            headers=auth(token),
            json={"current_password": "definitely-wrong", "new_password": "brand-new-password-2026"},
        )
        assert wrong.status_code == 401

        same = client.post(
            "/auth/change-password",
            headers=auth(token),
            json={"current_password": MEMBER_PASSWORD, "new_password": MEMBER_PASSWORD},
        )
        assert same.status_code == 422

        changed = client.post(
            "/auth/change-password",
            headers=auth(token),
            json={"current_password": MEMBER_PASSWORD, "new_password": "brand-new-password-2026"},
        )
        assert changed.status_code == 200, changed.text
        assert changed.json()["member"]["must_change_password"] is False

        # The acting session survives; every other session for that member is revoked.
        assert client.get(f"/projects/{project_id}", headers=auth(token)).status_code == 200
        assert client.get("/me", headers=auth(second_token)).status_code == 401
        assert client.post("/auth/login", json={"username": "ivan", "password": MEMBER_PASSWORD}).status_code == 401
        assert client.post(
            "/auth/login", json={"username": "ivan", "password": "brand-new-password-2026"}
        ).status_code == 200

        assert client.get("/me", headers=auth(token)).json()["must_change_password"] is False


def test_uploads_reject_corrupt_macro_and_mismatched_content():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, _ = open_round(client, teacher, "校验项目", ["第一段。"])
        headers = auth(teacher)

        assert client.post(
            f"/projects/{project_id}/documents", headers=headers, files=upload(b"not a zip at all", "broken.docx")
        ).status_code == 422
        assert client.post(
            f"/projects/{project_id}/documents", headers=headers, files=upload(docx("宏。"), "macro.docm")
        ).status_code == 422

        _, _, round2 = open_round(client, teacher, "哈希校验项目", ["第一段。", "第二段。"])
        mismatched = client.post(
            f"/rounds/{round2['id']}/submissions",
            headers=headers,
            data={"base_version_id": round2["base_version_id"], "sha256": "0" * 64, "note": "坏的"},
            files=upload(docx("第一段改。", "第二段。"), "x.docx"),
        )
        assert mismatched.status_code == 422

        stale = client.post(
            f"/rounds/{round2['id']}/submissions",
            headers=headers,
            data={"base_version_id": 999_999, "sha256": hashlib.sha256(docx("第一段改。", "第二段。")).hexdigest(), "note": "过期"},
            files=upload(docx("第一段改。", "第二段。"), "x.docx"),
        )
        assert stale.status_code == 409


def test_member_pending_password_change_may_still_log_out():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, _ = open_round(client, teacher, "改密登出项目", ["第一段。"])
        create_member(client, teacher, project_id, "rita")
        token = raw_login(client, "rita", MEMBER_PASSWORD)["access_token"]
        assert client.get("/me", headers=auth(token)).status_code == 200
        assert client.post("/auth/logout", headers=auth(token)).status_code == 200
        assert client.get("/me", headers=auth(token)).status_code == 401


def test_publish_result_requires_every_submission_to_be_terminal():
    """Two students submit; reviewing only one must not silently publish a half result."""
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "终态校验项目", ["第一段。", "第二段。"])
        nina = add_member(client, teacher, project_id, "nina")
        oscar = add_member(client, teacher, project_id, "oscar")
        base_version_id = round_["base_version_id"]

        first = submit(client, nina, round_["id"], base_version_id, docx("第一段已改。", "第二段。"), "甲")
        second = submit(client, oscar, round_["id"], base_version_id, docx("第一段。", "第二段已改。"), "乙")
        assert first.status_code == 200 and second.status_code == 200

        review_all(client, teacher, first.json()["id"])

        blocked = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert blocked.status_code == 409, blocked.text
        outstanding = blocked.json()["detail"]["outstanding"]
        assert [row["id"] for row in outstanding] == [second.json()["id"]], blocked.json()
        assert outstanding[0]["author"] == "oscar"
        assert outstanding[0]["status"] == "ready_for_review"

        # A student may not put their own submission aside to force the round open.
        assert client.post(
            f"/submissions/{second.json()['id']}/skip", headers=auth(oscar), json={}
        ).status_code == 403

        skipped = client.post(
            f"/submissions/{second.json()['id']}/skip", headers=auth(teacher), json={"reason": "本轮不参与"}
        )
        assert skipped.status_code == 200, skipped.text
        assert skipped.json()["status"] == "skipped"

        published = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert published.status_code == 200, published.text
        merged = client.get(f"/versions/{published.json()['version_id']}/download", headers=auth(teacher))
        text = document_text(merged.content)
        assert "第一段已改。" in text, text
        assert "第二段已改。" not in text, text


def test_finalize_creates_the_paragraph_a_student_inserted():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "新增段落项目", ["第一段。", "第二段。"])
        peter = add_member(client, teacher, project_id, "peter")
        revised = docx_body(
            paragraph("00000001", run("第一段。"))
            + paragraph("00000002", run("第二段。"))
            + paragraph("00000003", run("学生新加的一段。"))
        )
        submitted = submit(client, peter, round_["id"], round_["base_version_id"], revised, "新增一段")
        assert submitted.status_code == 200, submitted.text

        diff = review_all(client, teacher, submitted.json()["id"])
        assert any(hunk["operation"] == "insert" for hunk in diff["hunks"]), diff["hunks"]

        detail = client.get(f"/submissions/{submitted.json()['id']}/diff", headers=auth(teacher)).json()
        assert detail["status"] == "reviewed", detail
        resolved = client.get(f"/versions/{detail['resolved_version_id']}/download", headers=auth(teacher))
        assert document_text(resolved.content) == "第一段。第二段。学生新加的一段。"


def test_structural_change_needs_a_manual_merge_before_publishing():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "结构改动项目", ["第一段。", "第二段。"])
        quinn = add_member(client, teacher, project_id, "quinn")
        revised = docx_body(
            paragraph("00000001", run("第一段。"))
            + paragraph("00000002", run("第二段。"))
            + "<w:tbl><w:tr><w:tc>" + paragraph("000000T1", run("学生加的表格")) + "</w:tc></w:tr></w:tbl>"
        )
        submitted = submit(client, quinn, round_["id"], round_["base_version_id"], revised, "加了一张表")
        assert submitted.status_code == 200, submitted.text

        diff = client.get(f"/submissions/{submitted.json()['id']}/diff", headers=auth(teacher)).json()
        assert diff["hunks"], diff
        for hunk in diff["hunks"]:
            decided = client.patch(
                f"/reviews/{submitted.json()['id']}/hunks/{hunk['id']}",
                headers=auth(teacher),
                json={"decision": "accepted"},
            )
            assert decided.status_code == 200, decided.text

        blocked = client.post(f"/reviews/{submitted.json()['id']}/finalize", headers=auth(teacher))
        assert blocked.status_code == 409, blocked.text
        detail = blocked.json()["detail"]
        assert detail["status"] == "manual_required", detail
        assert detail["conflicts"][0]["reason"] == "cannot_determine_insert_position", detail

        stored = client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json()
        assert stored and stored[0]["source"] == "apply_decisions", stored

        still_blocked = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert still_blocked.status_code == 409, still_blocked.text
        assert still_blocked.json()["detail"]["outstanding"][0]["status"] == "manual_required"

        manual = docx("第一段。", "第二段。", "老师人工加的一段。")
        uploaded = client.post(
            f"/rounds/{round_['id']}/manual-result", headers=auth(teacher), files=upload(manual, "merged.docx")
        )
        assert uploaded.status_code == 200, uploaded.text
        conflicts = client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json()
        assert conflicts and all(c["status"] == "resolved" and c["resolution"] == "manual" for c in conflicts)


def test_replacing_the_main_document_adds_a_version_instead_of_a_second_document():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, document_id, _ = open_round(client, teacher, "替换主文档项目", ["第一段。"])
        headers = auth(teacher)
        replaced = client.post(
            f"/documents/{document_id}/versions",
            headers=headers,
            files=upload(docx("第一段。", "新加的一段。"), "main-v2.docx"),
        )
        assert replaced.status_code == 200, replaced.text
        body = replaced.json()
        assert body["document_id"] == document_id
        assert body["current_version_id"] == body["version_id"]

        documents = client.get(f"/projects/{project_id}/documents", headers=headers).json()
        assert len(documents) == 1, documents
        assert documents[0]["current_version_id"] == body["version_id"]

        versions = client.get(f"/documents/{document_id}/versions", headers=headers).json()
        assert versions[0]["id"] == body["version_id"]
        assert versions[0]["kind"] == "main" and versions[0]["current"] is True
        assert [v["id"] for v in versions].count(body["version_id"]) == 1

        sara = add_member(client, teacher, project_id, "sara")
        assert client.post(
            f"/documents/{document_id}/versions",
            headers=auth(sara),
            files=upload(docx("入侵。"), "x.docx"),
        ).status_code == 403


def test_conflicts_are_unique_per_round_and_anchor():
    """Re-publishing must not leave two conflict rows for the same contested spot."""
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "唯一约束项目", ["第一段。", "第二段。", "第三段。"])
        toby = add_member(client, teacher, project_id, "toby")
        uma = add_member(client, teacher, project_id, "uma")
        base_version_id = round_["base_version_id"]

        first = submit(client, toby, round_["id"], base_version_id, docx("第一段。", "第二段来自戊。", "第三段。"), "戊")
        second = submit(client, uma, round_["id"], base_version_id, docx("第一段。", "第二段来自己。", "第三段。"), "己")
        review_all(client, teacher, first.json()["id"])
        review_all(client, teacher, second.json()["id"])

        # Hitting publish twice records the same conflict twice; it must stay one row.
        for _ in range(2):
            blocked = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
            assert blocked.status_code == 409, blocked.text

        conflicts = client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json()
        anchors = [c["anchor"] for c in conflicts]
        assert len(anchors) == len(set(anchors)), anchors
        assert len(anchors) == 1, conflicts

        # Resolving keeps the record and the chosen side, it does not delete it.
        resolved = client.post(
            f"/rounds/{round_['id']}/publish-result",
            headers=auth(teacher),
            json={"conflict_choices": {anchors[0]: "toby"}},
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["resolution"] == "auto"
        after = client.get(f"/rounds/{round_['id']}/conflicts", headers=auth(teacher)).json()
        assert len(after) == 1, after
        assert after[0]["status"] == "resolved" and after[0]["resolution"] == "toby", after


def test_skipping_a_submission_unblocks_publishing():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "跳过项目", ["第一段。", "第二段。"])
        vince = add_member(client, teacher, project_id, "vince")
        wendy = add_member(client, teacher, project_id, "wendy")
        base_version_id = round_["base_version_id"]

        keep = submit(client, vince, round_["id"], base_version_id, docx("第一段改。", "第二段。"), "认真改了")
        drop = submit(client, wendy, round_["id"], base_version_id, docx("第一段。", "第二段乱改。"), "随便改的")
        review_all(client, teacher, keep.json()["id"])

        blocked = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert blocked.status_code == 409, blocked.text
        outstanding = blocked.json()["detail"]["outstanding"]
        assert [x["id"] for x in outstanding] == [drop.json()["id"]], outstanding
        assert outstanding[0]["author"] == "wendy"

        assert client.post(
            f"/submissions/{drop.json()['id']}/skip", headers=auth(wendy), json={"reason": "学生想跳过"}
        ).status_code == 403
        skipped = client.post(
            f"/submissions/{drop.json()['id']}/skip", headers=auth(teacher), json={"reason": "本人说这轮不参与"}
        )
        assert skipped.status_code == 200, skipped.text
        assert skipped.json()["status"] == "skipped"
        assert "本人说这轮不参与" in skipped.json()["note"]

        # Skipping twice is a no-op conflict, not a second state change.
        again = client.post(f"/submissions/{drop.json()['id']}/skip", headers=auth(teacher), json={})
        assert again.status_code == 409, again.text

        published = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert published.status_code == 200, published.text
        merged = client.get(f"/versions/{published.json()['version_id']}/download", headers=auth(teacher))
        text = document_text(merged.content)
        assert "第一段改。" in text, text
        assert "第二段乱改。" not in text, text


def test_conflicts_survive_a_restart_of_the_migration():
    """The unique index is what keeps a retry from duplicating rows, so assert it exists."""
    from app.main import IS_SQLITE, engine

    if not IS_SQLITE:
        return
    with engine.begin() as conn:
        indexes = {row[1] for row in conn.exec_driver_sql("PRAGMA index_list(merge_conflicts)")}
        assert "uq_merge_conflicts_round_anchor" in indexes, indexes
        unique = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA index_list(merge_conflicts)")
            if row[2] == 1
        }
        assert "uq_merge_conflicts_round_anchor" in unique, unique
        columns = [row[2] for row in conn.exec_driver_sql("PRAGMA index_info(uq_merge_conflicts_round_anchor)")]
        assert columns == ["round_id", "anchor"], columns
    # Any leftover duplicate would have made CREATE UNIQUE INDEX fail at startup.
    with engine.begin() as conn:
        duplicates = conn.exec_driver_sql(
            "SELECT round_id, anchor, COUNT(*) FROM merge_conflicts GROUP BY round_id, anchor HAVING COUNT(*) > 1"
        ).fetchall()
    assert duplicates == [], duplicates


def test_redline_warnings_travel_with_a_high_risk_submission():
    """A redline that could not express a change must say so, not look complete."""
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        # The paragraph carries a drawing, so `generate_redline` refuses to rebuild it
        # and reports `high_risk_block_not_redlined:<match_key>`.
        base_body = paragraph("00000001", '<w:r><w:t>图片说明：旧文字</w:t><w:drawing/></w:r>')
        revised_body = paragraph("00000001", '<w:r><w:t>图片说明：新文字甲</w:t><w:drawing/></w:r>')

        headers = auth(teacher)
        project_id = client.post("/projects", headers=headers, json={"name": "高风险项目"}).json()["id"]
        document = client.post(
            f"/projects/{project_id}/documents", headers=headers, files=upload(docx_body(base_body))
        )
        assert document.status_code == 200, document.text
        document_id = document.json()["id"]
        round_ = client.post(f"/projects/{project_id}/rounds", headers=headers, json={"document_id": document_id}).json()
        assert client.post(f"/rounds/{round_['id']}/publish", headers=headers).status_code == 200

        student = add_member(client, teacher, project_id, "gina")
        created = submit(
            client, student, round_["id"], round_["base_version_id"], docx_body(revised_body), "改了图片说明"
        )
        assert created.status_code == 200, created.text
        submission_id = created.json()["id"]

        diff = client.get(f"/submissions/{submission_id}/diff", headers=auth(teacher))
        assert diff.status_code == 200, diff.text
        warnings = diff.json()["redline_warnings"]
        assert any(w.startswith("high_risk_block_not_redlined:") for w in warnings), warnings

        listed = client.get(f"/rounds/{round_['id']}/submissions", headers=auth(teacher)).json()
        assert listed[0]["redline_warnings"] == warnings


def test_a_low_risk_submission_reports_no_redline_warnings():
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "普通项目", ["第一段。", "第二段。"])
        student = add_member(client, teacher, project_id, "henry")
        created = submit(
            client, student, round_["id"], round_["base_version_id"], docx("第一段。", "第二段已修改。"), "改第二段"
        )
        assert created.status_code == 200, created.text
        diff = client.get(f"/submissions/{created.json()['id']}/diff", headers=auth(teacher)).json()
        assert diff["redline_warnings"] == []


def test_submissions_table_has_the_additive_redline_warnings_column():
    from app.main import IS_SQLITE, engine

    if not IS_SQLITE:
        return
    with engine.begin() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(submissions)")}
    assert "redline_warnings" in columns, columns


def test_healthz_proves_the_engine_contract_instead_of_just_an_import():
    """`engine_available: true` alone is what let a stale engine run a live deployment."""
    import wordwork_doc_engine

    with TestClient(app) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok", body
    assert body["engine_available"] is True
    assert body["engine_compatible"] is True, body
    assert body["engine_contract"] == body["engine_contract_required"] == wordwork_doc_engine.ENGINE_CONTRACT_VERSION
    assert body["engine_version"] == wordwork_doc_engine.ENGINE_VERSION
    # The point of the field is to name *which copy* the service imported.
    assert body["engine_file"] == "__init__.py", body
    assert not Path(body["engine_file"]).is_absolute(), body
    assert body["engine_problem"] is None, body


def test_the_api_refuses_to_finalize_against_an_incompatible_engine(monkeypatch):
    """A mismatched engine must fail loudly at the gate — never as an AttributeError mid-review."""
    from app import main

    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, _, round_ = open_round(client, teacher, "引擎不匹配项目", ["第一段。", "第二段。"])
        student = add_member(client, teacher, project_id, "olive")
        created = submit(
            client, student, round_["id"], round_["base_version_id"], docx("第一段已改。", "第二段。"), "改第一段"
        )
        assert created.status_code == 200, created.text
        submission_id = created.json()["id"]
        hunks = client.get(f"/submissions/{submission_id}/diff", headers=auth(teacher)).json()["hunks"]
        assert hunks
        decided = client.patch(
            f"/reviews/{submission_id}/hunks/{hunks[0]['id']}", headers=auth(teacher), json={"decision": "accepted"}
        )
        assert decided.status_code == 200, decided.text

        # What the service venv actually reported while every finalize 500'd.
        stale = {
            "available": True,
            "compatible": False,
            "version": "0.1.0",
            "contract": 1,
            "file": r"C:\ProgramData\wordwork\venv\Lib\site-packages\wordwork_doc_engine\engine.py",
            "problem": "apply_decisions() 的返回值没有 needs_manual_review 布尔属性",
        }
        monkeypatch.setattr(main, "engine_status", lambda: stale)

        degraded = client.get("/healthz").json()
        assert degraded["status"] == "degraded", degraded
        assert degraded["engine_compatible"] is False
        assert "needs_manual_review" in degraded["engine_problem"]

        blocked = client.post(f"/reviews/{submission_id}/finalize", headers=auth(teacher))
        assert blocked.status_code == 503, blocked.text
        detail = blocked.json()["detail"]
        assert detail["code"] == "engine_contract_mismatch", detail
        assert detail["engine_contract"] == 1
        assert detail["required_contract"] == 2
        assert "needs_manual_review" in detail["problem"]


def test_only_promotable_version_kinds_can_become_the_main_version():
    """A redline is a *view* of a submission; promoting it would make revision marks the document."""
    with TestClient(app) as client:
        teacher = login(client, "teacher")
        project_id, document_id, round_ = open_round(client, teacher, "恢复限制项目", ["第一段。", "第二段。"])
        student = add_member(client, teacher, project_id, "nancy")
        created = submit(
            client, student, round_["id"], round_["base_version_id"], docx("第一段已改。", "第二段。"), "改第一段"
        )
        assert created.status_code == 200, created.text
        submission_id = created.json()["id"]
        submission_version_id = created.json()["version_id"]
        assert created.json()["redline_version_id"], created.json()

        review_all(client, teacher, submission_id)
        published = client.post(f"/rounds/{round_['id']}/publish-result", headers=auth(teacher), json={})
        assert published.status_code == 200, published.text

        versions = client.get(f"/documents/{document_id}/versions", headers=auth(teacher)).json()
        by_kind: dict[str, list[int]] = {}
        for version in versions:
            by_kind.setdefault(version["kind"], []).append(version["id"])
        for kind in ("redline", "summary_redline", "contribution", "draft"):
            for version_id in by_kind.get(kind, []):
                blocked = client.post(
                    f"/versions/{version_id}/restore", headers=auth(teacher), json={"document_id": document_id}
                )
                assert blocked.status_code == 409, (kind, version_id, blocked.text)
                detail = blocked.json()["detail"]
                assert detail["code"] == "version_kind_not_restorable", detail
                assert detail["kind"] == kind, detail
                assert set(detail["restorable_kinds"]) == {"main", "submission", "manual_merge"}, detail

        # A student may never restore anything, whatever the kind.
        assert client.post(
            f"/versions/{submission_version_id}/restore", headers=auth(student), json={"document_id": document_id}
        ).status_code == 403

        # The permitted kinds still work, and restoring does not touch the round's frozen base.
        allowed = client.post(
            f"/versions/{submission_version_id}/restore", headers=auth(teacher), json={"document_id": document_id}
        )
        assert allowed.status_code == 200, allowed.text
        current = [v for v in client.get(f"/documents/{document_id}/versions", headers=auth(teacher)).json() if v["current"]]
        assert current[0]["id"] == submission_version_id
        assert client.get(f"/rounds/{round_['id']}", headers=auth(teacher)).json()["base_version_id"] == round_["base_version_id"]
