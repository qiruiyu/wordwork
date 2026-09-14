"""Safety regressions for the P0 review-application defects.

Every fixture is generated here (never a real manuscript), and paragraph ids are pinned
so that inserting or deleting a paragraph does not renumber its neighbours.
"""

from __future__ import annotations

from pathlib import Path
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from wordwork_doc_engine import apply_decisions, compute_diff, generate_redline, merge_contributions

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CONTENT_TYPES = b'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
RELS = b'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'


def para(para_id: str, runs: str) -> str:
    return f'<w:p w14:paraId="{para_id}">{runs}</w:p>'


def run(text: str, rpr: str = "") -> str:
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'


def cell(para_id: str, text: str) -> str:
    return f'<w:tc>{para(para_id, run(text))}</w:tc>'


def write_docx(path: Path, body: str) -> None:
    document = (
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
        ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<w:body>{body}<w:sectPr/></w:body></w:document>"
    ).encode()
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", RELS)
        archive.writestr("word/document.xml", document)


def document_xml(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        return archive.read("word/document.xml").decode()


def texts(path: Path) -> list[str]:
    root = ET.fromstring(document_xml(path))
    return [
        "".join(node.text or "" for node in paragraph.iter() if node.tag == f"{{{W}}}t")
        for paragraph in root.iter(f"{{{W}}}p")
    ]


class EngineSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def path(self, name: str) -> Path:
        return self.root / name

    # ---- P0.2  formatting changes must never be reported as unchanged ----------------

    def test_pure_bold_change_becomes_a_format_hunk(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", run("研究目标是提高效率。")))
        write_docx(revised, para("00000001", run("研究目标是提高效率。", "<w:rPr><w:b/></w:rPr>")))
        diff = compute_diff(base, revised, "张同学")
        self.assertEqual(0, diff.unchanged_blocks)
        self.assertEqual(["format"], [hunk.operation for hunk in diff.hunks])
        result = apply_decisions(base, revised, diff, {diff.hunks[0].hunk_id: "accept"}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertIn("<w:b", document_xml(out))
        self.assertEqual(["研究目标是提高效率。"], texts(out))

    def test_rejected_format_change_keeps_original_styling(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", run("正文。")))
        write_docx(revised, para("00000001", run("正文。", "<w:rPr><w:i/></w:rPr>")))
        diff = compute_diff(base, revised, "张同学")
        result = apply_decisions(base, revised, diff, {}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertNotIn("<w:i", document_xml(out))
        self.assertEqual([], result.applied_hunk_ids)

    def test_rsid_only_run_properties_are_not_a_change(self) -> None:
        base, revised = self.path("b.docx"), self.path("r.docx")
        write_docx(base, para("00000001", run("正文。")))
        write_docx(revised, para("00000001", run("正文。", '<w:rPr w:rsidRPr="00AB12CD"/>')))
        diff = compute_diff(base, revised, "张同学")
        self.assertEqual([], diff.hunks)
        self.assertEqual(1, diff.unchanged_blocks)

    def test_paragraph_alignment_change_is_detected(self) -> None:
        base, revised = self.path("b.docx"), self.path("r.docx")
        write_docx(base, para("00000001", run("标题")))
        write_docx(revised, para("00000001", '<w:pPr><w:jc w:val="center"/></w:pPr>' + run("标题")))
        diff = compute_diff(base, revised, "A")
        self.assertEqual(["format"], [hunk.operation for hunk in diff.hunks])

    # ---- P0.3  complex content must never be rebuilt from plain text ------------------

    def test_partial_edit_on_image_paragraph_becomes_a_manual_conflict(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", f'<w:r><w:t>图片说明：旧文字</w:t><w:drawing/></w:r>'))
        write_docx(revised, para("00000001", f'<w:r><w:t>图片说明：新文字甲</w:t><w:drawing/></w:r>'))
        diff = compute_diff(base, revised, "A")
        replace = [hunk for hunk in diff.hunks if hunk.operation == "replace"]
        self.assertTrue(replace)
        result = apply_decisions(base, revised, diff, {replace[0].hunk_id: "accept"}, out)
        self.assertTrue(result.needs_manual_review)
        self.assertEqual("complex_edit", result.conflicts[0].kind)
        self.assertEqual("fragment_edit_on_complex_block_requires_manual", result.conflicts[0].reason)
        self.assertIn("<w:drawing", document_xml(out))
        self.assertEqual(["图片说明：旧文字"], texts(out))

    def test_partial_edit_on_hyperlink_paragraph_becomes_a_manual_conflict(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", '<w:hyperlink r:id="rId4"><w:r><w:t>参见指南第一章</w:t></w:r></w:hyperlink>'))
        write_docx(revised, para("00000001", '<w:hyperlink r:id="rId4"><w:r><w:t>参见指南第二节</w:t></w:r></w:hyperlink>'))
        diff = compute_diff(base, revised, "A")
        decisions = {hunk.hunk_id: "accept" for hunk in diff.hunks if hunk.operation == "replace"}
        result = apply_decisions(base, revised, diff, decisions, out)
        self.assertTrue(result.needs_manual_review)
        self.assertIn('r:id="rId4"', document_xml(out))

    def test_whole_block_replacement_of_plain_paragraph_is_still_applied(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", run("旧段落内容。")))
        write_docx(revised, para("00000001", run("全新段落内容。")))
        diff = compute_diff(base, revised, "A")
        result = apply_decisions(base, revised, diff, {hunk.hunk_id: "accept" for hunk in diff.hunks}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertEqual(["全新段落内容。"], texts(out))

    # ---- P0.1  accepted insertions / deletions must actually change the document ------

    def test_accepted_insertion_lands_in_document_order(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")) + para("0000000B", run("乙")))
        write_docx(revised, para("0000000A", run("甲")) + para("0000000C", run("新段")) + para("0000000B", run("乙")))
        diff = compute_diff(base, revised, "A")
        self.assertEqual(["insert"], [hunk.operation for hunk in diff.hunks])
        result = apply_decisions(base, revised, diff, {diff.hunks[0].hunk_id: "accept"}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertEqual(["甲", "新段", "乙"], texts(out))

    def test_consecutive_insertions_keep_their_order(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")))
        write_docx(revised, para("0000000A", run("甲")) + para("0000000C", run("第一段")) + para("0000000D", run("第二段")))
        diff = compute_diff(base, revised, "A")
        result = apply_decisions(base, revised, diff, {hunk.hunk_id: "accept" for hunk in diff.hunks}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertEqual(["甲", "第一段", "第二段"], texts(out))

    def test_rejected_insertion_is_not_applied(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")) + para("0000000B", run("乙")))
        write_docx(revised, para("0000000A", run("甲")) + para("0000000C", run("新段")) + para("0000000B", run("乙")))
        diff = compute_diff(base, revised, "A")
        result = apply_decisions(base, revised, diff, {}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertEqual(["甲", "乙"], texts(out))
        self.assertEqual([hunk.hunk_id for hunk in diff.hunks], result.rejected_hunk_ids)

    def test_accepted_deletion_removes_the_paragraph(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")) + para("0000000B", run("乙")) + para("0000000C", run("丙")))
        write_docx(revised, para("0000000A", run("甲")) + para("0000000C", run("丙")))
        diff = compute_diff(base, revised, "A")
        self.assertEqual(["delete"], [hunk.operation for hunk in diff.hunks])
        result = apply_decisions(base, revised, diff, {diff.hunks[0].hunk_id: "accept"}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertEqual(["甲", "丙"], texts(out))
        self.assertTrue(any(warning.startswith("deleted_block:") for warning in result.warnings))

    def test_rejected_deletion_keeps_the_paragraph(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")) + para("0000000B", run("乙")))
        write_docx(revised, para("0000000A", run("甲")))
        diff = compute_diff(base, revised, "A")
        result = apply_decisions(base, revised, diff, {}, out)
        self.assertFalse(result.needs_manual_review)
        self.assertEqual(["甲", "乙"], texts(out))

    def test_insertion_inside_a_brand_new_table_is_a_manual_conflict(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")))
        write_docx(revised, para("0000000A", run("甲")) + f"<w:tbl><w:tr>{cell('000000T1', '格')}</w:tr></w:tbl>")
        diff = compute_diff(base, revised, "A")
        self.assertTrue(diff.hunks)
        result = apply_decisions(base, revised, diff, {hunk.hunk_id: "accept" for hunk in diff.hunks}, out)
        self.assertTrue(result.needs_manual_review)
        self.assertEqual("insert", result.conflicts[0].kind)
        self.assertEqual("cannot_determine_insert_position", result.conflicts[0].reason)
        self.assertEqual(["甲"], texts(out))

    def test_result_is_json_serializable_and_reports_hunk_ids(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")) + para("0000000B", run("乙")))
        write_docx(revised, para("0000000A", run("甲改")) + para("0000000C", run("新")) + para("0000000B", run("乙")))
        diff = compute_diff(base, revised, "A")
        first = diff.hunks[0].hunk_id
        result = apply_decisions(base, revised, diff, {first: "accept"}, out)
        payload = json.loads(json.dumps(result.to_dict(), ensure_ascii=False))
        self.assertEqual([first], payload["applied_hunk_ids"])
        self.assertEqual(sorted({hunk.hunk_id for hunk in diff.hunks} - {first}), payload["rejected_hunk_ids"])
        self.assertEqual(0, len(payload["conflicts"]))

    def test_merge_contributions_still_works_after_return_type_change(self) -> None:
        base, one, two, merged = (self.path(name) for name in ("b.docx", "1.docx", "2.docx", "m.docx"))
        write_docx(base, para("0000000A", run("甲")) + para("0000000B", run("乙")))
        write_docx(one, para("0000000A", run("甲一")) + para("0000000B", run("乙")))
        write_docx(two, para("0000000A", run("甲")) + para("0000000B", run("乙二")))
        result = merge_contributions(base, [(one, "甲同学"), (two, "乙同学")], merged)
        self.assertFalse(result.conflicts)
        self.assertEqual(["甲一", "乙二"], texts(merged))


class RedlineDeterminismTests(unittest.TestCase):
    """A redline must be reproducible and must never hide a change it cannot express."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def path(self, name: str) -> Path:
        return self.root / name

    def revisions(self, path: Path) -> list[ET.Element]:
        root = ET.fromstring(document_xml(path))
        return [node for node in root.iter() if node.tag in {f"{{{W}}}ins", f"{{{W}}}del"}]

    def test_the_same_input_produces_byte_identical_redlines(self) -> None:
        base, revised = self.path("b.docx"), self.path("r.docx")
        write_docx(base, para("00000001", run("研究目标是提高效率。")) + para("00000002", run("方法是抽样。")))
        write_docx(revised, para("00000001", run("研究目标是提升效率。")) + para("00000002", run("方法是分层抽样。")))
        first, second = self.path("one.docx"), self.path("two.docx")
        generate_redline(base, revised, "张同学", first)
        generate_redline(base, revised, "张同学", second)
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_every_revision_id_is_distinct_across_paragraphs(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", run("甲甲甲")) + para("00000002", run("乙乙乙")))
        write_docx(revised, para("00000001", run("丙丙丙")) + para("00000002", run("丁丁丁")))
        generate_redline(base, revised, "张同学", out)
        elements = self.revisions(out)
        ids = [node.get(f"{{{W}}}id") for node in elements]
        self.assertEqual(4, len(ids))
        self.assertEqual(len(ids), len(set(ids)))
        self.assertNotIn(None, ids)

    def test_a_wholly_new_paragraph_is_marked_as_an_insertion(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")))
        write_docx(revised, para("0000000A", run("甲")) + para("0000000C", run("新段")))
        result = generate_redline(base, revised, "张同学", out)
        self.assertEqual([], result.warnings)
        self.assertEqual(["甲", "新段"], texts(out))
        inserted = ET.fromstring(document_xml(out)).find(f".//{{{W}}}ins")
        self.assertIsNotNone(inserted)
        # The paragraph mark itself must be flagged too, otherwise Word merges the new
        # paragraph into the previous one when the revision is accepted.
        self.assertIn("<w:ins", document_xml(out))
        self.assertEqual(2, len(self.revisions(out)))

    def test_a_wholly_removed_paragraph_is_marked_as_a_deletion(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")) + para("0000000B", run("乙")))
        write_docx(revised, para("0000000A", run("甲")))
        result = generate_redline(base, revised, "张同学", out)
        self.assertEqual([], result.warnings)
        self.assertEqual("乙", self.deleted_text(out))
        self.assertEqual(2, len(self.revisions(out)))

    def deleted_text(self, path: Path) -> str:
        root = ET.fromstring(document_xml(path))
        return "".join(node.text or "" for node in root.iter() if node.tag == f"{{{W}}}delText")

    def test_a_deletion_never_leaves_a_plain_text_run_behind(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", '<w:hyperlink r:id="rId4"><w:r><w:t>旧链接文字</w:t></w:r></w:hyperlink>'))
        write_docx(revised, para("00000001", '<w:hyperlink r:id="rId4"><w:r><w:t>旧链接文字</w:t></w:r></w:hyperlink>'))
        write_docx(revised, para("00000002", run("另一段")))
        # A hyperlink-only paragraph whose text changes is high-risk and is reported, not
        # rebuilt; the point here is that whatever we do emit stays valid OOXML.
        result = generate_redline(base, revised, "张同学", out)
        self.assertTrue(result.warnings)
        root = ET.fromstring(document_xml(out))
        deletions = [node for node in root.iter() if node.tag == f"{{{W}}}del"]
        for deletion in deletions:
            self.assertFalse([node for node in deletion.iter() if node.tag == f"{{{W}}}t"])

    def test_a_drawing_paragraph_is_reported_instead_of_being_redlined(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("00000001", '<w:r><w:t>图片说明：旧文字</w:t><w:drawing/></w:r>'))
        write_docx(revised, para("00000001", '<w:r><w:t>图片说明：新文字甲</w:t><w:drawing/></w:r>'))
        result = generate_redline(base, revised, "张同学", out)
        self.assertTrue(any(warning.startswith("high_risk_block_not_redlined:") for warning in result.warnings))
        self.assertEqual([], self.revisions(out))
        self.assertIn("<w:drawing", document_xml(out))

    def test_a_new_table_is_reported_rather_than_silently_dropped(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲")))
        write_docx(revised, para("0000000A", run("甲")) + f"<w:tbl><w:tr>{cell('000000T1', '格')}</w:tr></w:tbl>")
        result = generate_redline(base, revised, "张同学", out)
        self.assertTrue(any(warning.startswith("not_redlined_insert:") for warning in result.warnings))
        self.assertNotIn("<w:tbl", document_xml(out))

    def test_mixed_insert_replace_delete_keeps_every_id_unique(self) -> None:
        base, revised, out = self.path("b.docx"), self.path("r.docx"), self.path("o.docx")
        write_docx(base, para("0000000A", run("甲甲")) + para("0000000B", run("乙乙")) + para("0000000C", run("丙丙")))
        write_docx(revised, para("0000000A", run("甲甲")) + para("0000000D", run("新段")) + para("0000000C", run("丙丁")))
        result = generate_redline(base, revised, "张同学", out)
        self.assertEqual([], result.warnings)
        ids = [node.get(f"{{{W}}}id") for node in self.revisions(out)]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(ids), 4)
        # The removed paragraph stays in place, wrapped in `w:del`, so it still occupies a
        # paragraph slot but contributes no visible text.
        self.assertEqual(["甲甲", "新段", "", "丙丁"], texts(out))
        # "丙" also shows up here: replacing 丙丙 with 丙丁 deletes one character inside a
        # paragraph that stays, so both a whole-paragraph and an in-place deletion exist.
        self.assertIn("乙乙", self.deleted_text(out))


if __name__ == "__main__":
    unittest.main()
