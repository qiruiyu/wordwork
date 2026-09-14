"""Public, JSON-serializable DOCX review primitives for wordwork."""

from .engine import (
    ENGINE_CONTRACT_VERSION,
    ENGINE_VERSION,
    ApplyConflict,
    ApplyResult,
    Block,
    Contribution,
    DiffResult,
    Hunk,
    MergeConflict,
    MergeResult,
    RedlineResult,
    ValidationResult,
    apply_decisions,
    compute_diff,
    engine_info,
    generate_redline,
    merge_contributions,
    validate_docx,
    verify_contract,
)

__all__ = [
    "ApplyConflict", "ApplyResult", "Block", "Contribution", "DiffResult", "Hunk",
    "MergeConflict", "MergeResult", "RedlineResult", "ValidationResult", "apply_decisions",
    "compute_diff", "generate_redline", "merge_contributions", "validate_docx",
    "ENGINE_VERSION", "ENGINE_CONTRACT_VERSION", "engine_info", "verify_contract",
]
