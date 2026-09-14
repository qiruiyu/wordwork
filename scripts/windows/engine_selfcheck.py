"""Prove the DOCX engine the *service* will import is the one this repo ships.

Run with the deployment venv's python, right after `pip install`:

    <venv>\\Scripts\\python.exe engine_selfcheck.py --expect-prefix <venv>\\Lib\\site-packages

Exits 0 and prints a short report when the installed engine satisfies the contract
`services/api/app/main.py` is written against; exits 1 with the reason otherwise.

Why this exists: the deployment once reported `engine_available: true` while
`apply_decisions()` still returned a bare `Path`, and the mismatch only surfaced as
`AttributeError` when the teacher clicked "完成审阅". Importing successfully is not
evidence of compatibility, so this checks the result objects themselves *and* which
file they came from.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Must match `ENGINE_REQUIRED_CONTRACT` in `services/api/app/main.py`.
REQUIRED_CONTRACT = 2


def main(argv: list[str]) -> int:
    expect_prefix: Path | None = None
    if "--expect-prefix" in argv:
        expect_prefix = Path(argv[argv.index("--expect-prefix") + 1]).resolve()

    try:
        import wordwork_doc_engine as engine
    except ImportError as exc:
        print(f"[FAIL] 无法导入 wordwork_doc_engine：{exc}")
        return 1

    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:  # pragma: no cover - only on very old Pythons
        PackageNotFoundError = Exception  # type: ignore[assignment]
        version = None  # type: ignore[assignment]

    dist_version = None
    if version is not None:
        try:
            dist_version = version("wordwork-doc-engine")
        except PackageNotFoundError:
            dist_version = None

    module_file = Path(engine.__file__).resolve()
    contract = getattr(engine, "ENGINE_CONTRACT_VERSION", None)
    engine_version = getattr(engine, "ENGINE_VERSION", None)
    probe = getattr(engine, "verify_contract", None)
    problems = list(probe()) if callable(probe) else ["引擎缺少 verify_contract()（0.1.0 及更早版本都有这个问题）"]

    print(f"引擎文件    : {module_file}")
    print(f"引擎版本    : {engine_version}（包元数据 {dist_version}）")
    print(f"契约版本    : {contract}")
    print(f"Python      : {sys.executable}")

    if engine_version and dist_version and engine_version != dist_version:
        # Same trap as `pip install` reusing a cached wheel: the code and the metadata
        # disagree, so `pip install --upgrade` will not fix it on its own.
        problems.append(f"代码里的版本号 {engine_version} 与包元数据 {dist_version} 不一致")

    if contract != REQUIRED_CONTRACT:
        problems.append(f"契约版本不匹配：本 API 需要 {REQUIRED_CONTRACT}，实际 {contract}")

    if expect_prefix is not None:
        try:
            module_file.relative_to(expect_prefix)
        except ValueError:
            problems.append(f"引擎不是从部署环境加载的（应在 {expect_prefix} 下）")

    if problems:
        print("[FAIL] 部署自检未通过：")
        for problem in problems:
            print(f"       - {problem}")
        return 1

    print("[OK] 引擎与 API 契约一致，部署可用。")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover
        pass
    raise SystemExit(main(sys.argv[1:]))
