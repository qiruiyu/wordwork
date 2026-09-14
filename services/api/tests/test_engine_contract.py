"""The deployed engine must *prove* its contract; a stale copy must not look healthy.

A deployment once reported `engine_available: true` from a `wordwork_doc_engine 0.1.0`
that had been left in the service venv, so every "完成审阅" died with
`AttributeError: 'WindowsPath' object has no attribute 'needs_manual_review'` while the
health check stayed green. Version numbers were identical, so nothing comparing numbers
would have caught it. These tests pin down the two things that do: probing the result
objects the API actually reads, and proving which file the interpreter loaded.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("WORDWORK_DATA_DIR", tempfile.mkdtemp(prefix="wordwork-engine-contract-"))

REPO = Path(__file__).resolve().parents[3]
SELFCHECK = REPO / "scripts" / "windows" / "engine_selfcheck.py"

# The surface a 0.1.0 install actually had: `apply_decisions()` returned a bare `Path`,
# `generate_redline()` had no `warnings`, and neither `verify_contract` nor
# `ENGINE_CONTRACT_VERSION` existed yet.
LEGACY_ENGINE = '''
"""A faithful stand-in for a pre-contract wordwork_doc_engine."""
from pathlib import Path

ENGINE_VERSION = "0.1.0"


def apply_decisions(*args, **kwargs):
    return Path("resolved.docx")


def compute_diff(*args, **kwargs):
    return {}


def generate_redline(*args, **kwargs):
    return Path("redline.docx")


def merge_contributions(*args, **kwargs):
    return {}


def validate_docx(*args, **kwargs):
    return True
'''


def test_the_shipped_engine_satisfies_the_contract_it_advertises():
    import wordwork_doc_engine as engine

    assert engine.verify_contract() == []
    assert engine.ENGINE_CONTRACT_VERSION == 2
    info = engine.engine_info()
    assert info["compatible"] is True
    assert info["contract"] == engine.ENGINE_CONTRACT_VERSION
    assert info["version"] == engine.ENGINE_VERSION
    assert Path(info["file"]).name == "engine.py"


def test_contract_probe_rejects_a_legacy_result_object(monkeypatch):
    """Belt and braces: even if the version numbers lie, the probe reads the objects."""
    from wordwork_doc_engine import engine

    class LegacyApplyResult:
        def __init__(self, output_path: str = "") -> None:
            self.output_path = output_path

    monkeypatch.setattr(engine, "ApplyResult", LegacyApplyResult)
    problems = engine.verify_contract()
    assert any("needs_manual_review" in problem for problem in problems), problems


def test_contract_probe_reports_a_missing_entry_point(monkeypatch):
    from wordwork_doc_engine import engine

    monkeypatch.delattr(engine, "merge_contributions")
    problems = engine.verify_contract()
    assert any("merge_contributions" in problem for problem in problems), problems


def test_the_selfcheck_script_passes_on_the_current_interpreter():
    result = subprocess.run(
        [sys.executable, str(SELFCHECK)], capture_output=True, text=True, encoding="utf-8"
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "[OK]" in result.stdout
    # It must name the file it actually loaded, not just "the engine".
    assert "wordwork_doc_engine" in result.stdout
    assert "契约版本" in result.stdout


def test_the_selfcheck_script_refuses_a_legacy_engine():
    """Fabricate a 0.1.0 engine ahead of site-packages and prove the check fails it.

    `PYTHONPATH` entries are searched before site-packages, so the fake wins without
    touching the real installation. `tmp_path` is deliberately not used: the shared
    pytest tmp dir on this machine is not writable under some ACLs, which is why the
    rest of the suite builds its own temp dirs too.
    """
    scratch = Path(tempfile.mkdtemp(prefix="wordwork-legacy-engine-"))
    try:
        package = scratch / "wordwork_doc_engine"
        package.mkdir()
        (package / "__init__.py").write_text(LEGACY_ENGINE, encoding="utf-8")

        environment = {**os.environ, "PYTHONPATH": str(scratch)}
        result = subprocess.run(
            [sys.executable, str(SELFCHECK)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=environment,
            cwd=scratch,
        )

        assert result.returncode == 1, result.stdout + result.stderr
        assert "[FAIL]" in result.stdout
        # It must name the specific gap, not just "something is wrong".
        assert "verify_contract" in result.stdout or "契约版本" in result.stdout, result.stdout
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
