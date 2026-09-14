"""Deterministic DOCX block diff/merge without an Office runtime.

The implementation is intentionally conservative.  A paragraph or table cell is
the smallest safe OOXML write unit; all other ZIP members are retained unchanged.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from difflib import SequenceMatcher
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable, Mapping
import copy
import os
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
RD = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"w": W, "w14": W14, "r": R}
ET.register_namespace("w", W)
ET.register_namespace("w14", W14)
# Word writes relationship references as `r:id`; without this ElementTree would emit a
# synthetic `ns2:` prefix, which Word tolerates but which makes diffs of our own output
# unreadable and trips naive reviewers.
ET.register_namespace("r", RD)

MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024
MAX_RATIO = 100
MAX_MEMBERS = 10_000
_WORD_PART = re.compile(r"^word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$")
_MACRO_TYPES = ("macroenabled", "vbaProject", "vbaData")

# Keep this in step with `pyproject.toml`. It is reported by `/healthz`.
ENGINE_VERSION = "0.2.1"

# Bumped whenever a result object the API reads changes shape. The API refuses to
# serve engine-dependent endpoints when its own expectation does not match, instead
# of failing later with an `AttributeError` in the middle of the teacher's review.
#
#   1 → apply_decisions() returned a bare Path
#   2 → apply_decisions() returns ApplyResult, and RedlineResult carries `warnings`
ENGINE_CONTRACT_VERSION = 2


@dataclass(slots=True)
class JsonModel:
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ValidationResult(JsonModel):
    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    sha256: str | None = None
    size_bytes: int = 0
    member_count: int = 0


@dataclass(slots=True)
class Block(JsonModel):
    block_id: str
    match_key: str
    part: str
    kind: str
    anchor: str
    path: str
    fingerprint: str
    text: str
    structure_fingerprint: str
    format_fingerprint: str
    risks: list[str] = field(default_factory=list)


@dataclass(slots=True)
class Hunk(JsonModel):
    hunk_id: str
    block_id: str
    match_key: str
    author: str
    operation: str
    base_text: str
    revised_text: str
    before: str
    after: str
    risks: list[str] = field(default_factory=list)


@dataclass(slots=True)
class DiffResult(JsonModel):
    author: str
    base_sha256: str
    revised_sha256: str
    hunks: list[Hunk]
    unchanged_blocks: int
    warnings: list[str] = field(default_factory=list)
    base_blocks: list[Block] = field(default_factory=list)
    revised_blocks: list[Block] = field(default_factory=list)


@dataclass(slots=True)
class Contribution(JsonModel):
    author: str
    source_path: str
    accepted_hunk_ids: list[str]
    changed_match_keys: list[str]


@dataclass(slots=True)
class MergeConflict(JsonModel):
    conflict_id: str
    match_key: str
    part: str
    base_text: str
    current_text: str
    incoming_text: str
    current_author: str
    incoming_author: str
    reason: str = "same_structural_block"


@dataclass(slots=True)
class MergeResult(JsonModel):
    output_path: str
    applied_contributions: list[Contribution]
    conflicts: list[MergeConflict]
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RedlineResult(JsonModel):
    output_path: str
    diff: DiffResult
    engine: str
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ApplyConflict(JsonModel):
    """A change the teacher accepted but the engine refuses to apply on its own."""

    match_key: str
    part: str
    anchor: str
    kind: str
    reason: str
    detail: str = ""
    hunk_ids: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ApplyResult(JsonModel):
    output_path: str
    applied_hunk_ids: list[str] = field(default_factory=list)
    rejected_hunk_ids: list[str] = field(default_factory=list)
    conflicts: list[ApplyConflict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def needs_manual_review(self) -> bool:
        return bool(self.conflicts)


def _digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def _file_digest(path: Path) -> str:
    hash_ = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hash_.update(chunk)
    return hash_.hexdigest()


def _safe_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    return not (normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized)
                or any(part == ".." for part in normalized.split("/")))


def validate_docx(path: str | Path) -> ValidationResult:
    """Validate a non-encrypted, macro-free DOCX without extracting it."""
    source = Path(path)
    errors: list[str] = []
    warnings: list[str] = []
    if not source.is_file():
        return ValidationResult(False, ["file_not_found"])
    size = source.stat().st_size
    digest = _file_digest(source)
    if source.suffix.lower() != ".docx":
        errors.append("extension_not_docx")
    if size > MAX_FILE_BYTES:
        errors.append("file_too_large")
    if not zipfile.is_zipfile(source):
        return ValidationResult(False, errors + ["not_a_zip"], warnings, digest, size)
    try:
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_MEMBERS:
                errors.append("too_many_zip_members")
            total_uncompressed = sum(item.file_size for item in infos)
            if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
                errors.append("uncompressed_size_limit")
            for item in infos:
                if not _safe_member(item.filename):
                    errors.append("zip_slip_path")
                if item.flag_bits & 0x1:
                    errors.append("encrypted_zip_member")
                if item.file_size and (not item.compress_size or item.file_size / item.compress_size > MAX_RATIO):
                    errors.append("suspicious_compression_ratio")
                lower = item.filename.lower()
                if lower.endswith(("vbaproject.bin", "vbadata.xml")):
                    errors.append("macro_part_detected")
            names = set(archive.namelist())
            if len(names) != len(infos):
                errors.append("duplicate_zip_member")
            if {"EncryptionInfo", "EncryptedPackage"} & names:
                errors.append("encrypted_ooxml_package")
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                errors.append("missing_required_docx_parts")
            content_types = archive.read("[Content_Types].xml").lower() if "[Content_Types].xml" in names else b""
            if any(marker.lower().encode() in content_types for marker in _MACRO_TYPES):
                errors.append("macro_content_type_detected")
            for name in names:
                if not name.endswith(".rels"):
                    continue
                try:
                    relationships = ET.fromstring(archive.read(name))
                except ET.ParseError:
                    errors.append("invalid_relationship_xml")
                    continue
                if any(node.get("TargetMode") == "External" for node in relationships):
                    warnings.append(f"external_relationship:{name}")
            for name in names:
                if _WORD_PART.match(name):
                    try:
                        ET.fromstring(archive.read(name))
                    except ET.ParseError:
                        errors.append("invalid_ooxml_xml")
    except (OSError, zipfile.BadZipFile, RuntimeError):
        errors.append("unreadable_zip")
    return ValidationResult(not errors, sorted(set(errors)), sorted(set(warnings)), digest, size, len(infos) if 'infos' in locals() else 0)


def _read_xml_parts(path: Path) -> dict[str, ET.Element]:
    with zipfile.ZipFile(path) as archive:
        result: dict[str, ET.Element] = {}
        for name in archive.namelist():
            if _WORD_PART.match(name):
                result[name] = ET.fromstring(archive.read(name))
        return result


def _element_text(element: ET.Element) -> str:
    return "".join(node.text or "" for node in element.iter() if node.tag in {f"{{{W}}}t", f"{{{W}}}delText"})


def _risk_flags(element: ET.Element, part: str) -> list[str]:
    flags: set[str] = set()
    if part != "word/document.xml":
        flags.add("header_footer_or_note_part")
    tags = {node.tag.rsplit("}", 1)[-1] for node in element.iter()}
    if tags & {"drawing", "pict", "object", "chart"}:
        flags.add("drawing_or_chart")
    if any(node.tag.startswith("{http://schemas.openxmlformats.org/officeDocument/2006/math}") for node in element.iter()):
        flags.add("equation")
    if tags & {"fldSimple", "instrText", "hyperlink", "sdt"}:
        flags.add("field_or_link")
    if tags & {"ins", "del", "moveFrom", "moveTo"}:
        flags.add("existing_track_changes")
    return sorted(flags)


def _structure_fingerprint(element: ET.Element) -> str:
    """Hash the high-risk object payloads without letting ordinary text affect it."""
    interesting = {"drawing", "pict", "object", "chart", "fldSimple", "instrText", "hyperlink", "sdt"}
    payload: list[bytes] = []
    for node in element.iter():
        local = node.tag.rsplit("}", 1)[-1]
        if local in interesting or node.tag.startswith("{http://schemas.openxmlformats.org/officeDocument/2006/math}"):
            # `rsid*` is Word's edit-session noise and must not create a conflict.
            attributes = sorted((key, value) for key, value in node.attrib.items() if "rsid" not in key.lower())
            payload.append(repr((node.tag, attributes, node.text or "")).encode("utf-8"))
    return _digest(b"\0".join(payload))[:16]


_FORMAT_TAGS = ("pPr", "rPr")
# `rsid*` attributes are Word's edit-session bookkeeping.  A container holding nothing but
# them (`<w:rPr w:rsidRPr="00AB12"/>`) is not a formatting change, but an empty *toggle*
# such as `<w:b/>` is — hence the container allow-list rather than a blanket empty check.
_RSID_CONTAINERS = {"pPr", "rPr", "sectPr", "trPr", "tcPr"}


def _format_repr(node: ET.Element) -> tuple | None:
    attributes = tuple(sorted((key, value) for key, value in node.attrib.items() if "rsid" not in key.lower()))
    children = tuple(item for item in (_format_repr(child) for child in node) if item is not None)
    if node.tag.rsplit("}", 1)[-1] in _RSID_CONTAINERS and not attributes and not children:
        return None
    return (node.tag, attributes, node.text or "", children)


def _format_fingerprint(element: ET.Element) -> str:
    """Hash paragraph and run formatting so a pure restyle is never reported as unchanged.

    Only ``w:pPr`` / ``w:rPr`` participate, so re-saving the same document in Word does
    not produce a phantom change.
    """
    payload: list[bytes] = []
    for node in element.iter():
        if node.tag.rsplit("}", 1)[-1] not in _FORMAT_TAGS:
            continue
        rendered = _format_repr(node)
        if rendered is not None:
            payload.append(repr(rendered).encode("utf-8"))
    return _digest(b"\0".join(payload))[:16]


def _walk_blocks(root: ET.Element, part: str) -> tuple[list[Block], dict[str, ET.Element]]:
    blocks: list[Block] = []
    elements: dict[str, ET.Element] = {}
    parent = {child: node for node in root.iter() for child in node}
    body = root.find("w:body", NS)
    if body is None:
        body = root

    def visit(container: ET.Element, prefix: str, in_cell: bool = False) -> None:
        counters: dict[str, int] = {}
        for child in list(container):
            local = child.tag.rsplit("}", 1)[-1]
            index = counters.get(local, 0)
            counters[local] = index + 1
            child_path = f"{prefix}/{local}[{index}]"
            if child.tag == f"{{{W}}}p":
                para_id = child.get(f"{{{W14}}}paraId")
                anchor = f"paraId:{para_id}" if para_id else child_path
                kind = "table_cell" if in_cell else "paragraph"
                text = _element_text(child)
                fingerprint = _digest((kind + "\0" + text).encode())[:16]
                match_key = f"{part}|{kind}|{anchor}"
                block_id = f"{match_key}|{fingerprint}"
                block = Block(block_id, match_key, part, kind, anchor, child_path, fingerprint, text,
                              _structure_fingerprint(child), _format_fingerprint(child), _risk_flags(child, part))
                blocks.append(block)
                elements[match_key] = child
            elif child.tag == f"{{{W}}}tbl":
                visit(child, child_path, in_cell)
            elif child.tag == f"{{{W}}}tr":
                visit(child, child_path, in_cell)
            elif child.tag == f"{{{W}}}tc":
                visit(child, child_path, True)
            elif child.tag in {f"{{{W}}}body", f"{{{W}}}footnote", f"{{{W}}}endnote"}:
                visit(child, child_path, in_cell)

    visit(body, "body")
    return blocks, elements


def _load_blocks(path: Path) -> tuple[list[Block], dict[str, ET.Element], dict[str, ET.Element]]:
    parts = _read_xml_parts(path)
    all_blocks: list[Block] = []
    elements: dict[str, ET.Element] = {}
    for name, root in parts.items():
        blocks, part_elements = _walk_blocks(root, name)
        all_blocks.extend(blocks)
        elements.update(part_elements)
    return all_blocks, elements, parts


def _matching(base: Iterable[Block], revised: Iterable[Block]) -> dict[str, tuple[Block | None, Block | None]]:
    old = {block.match_key: block for block in base}
    new = {block.match_key: block for block in revised}
    return {key: (old.get(key), new.get(key)) for key in sorted(set(old) | set(new))}


def _tokenize(text: str) -> list[str]:
    """Tokenize CJK at character granularity and keep latin words together.

    Chinese grant prose normally has no whitespace, so treating an entire sentence
    as one ``\\w+`` token would turn a two-character insertion into a paragraph-wide
    replacement.  Character-granular CJK tokens give the review UI useful hunks
    without bringing a language model or remote tokenizer into the trust boundary.
    """
    return re.findall(r"\s+|[\u3400-\u9fff]|[A-Za-z0-9_]+|[^\w\s]", text, flags=re.UNICODE)


def _make_hunks(base: Block | None, revised: Block | None, author: str) -> list[Hunk]:
    reference = base or revised
    assert reference is not None
    old, new = (base.text if base else ""), (revised.text if revised else "")
    matcher = SequenceMatcher(a=_tokenize(old), b=_tokenize(new), autojunk=False)
    hunks: list[Hunk] = []
    for ordinal, (op, a1, a2, b1, b2) in enumerate(matcher.get_opcodes()):
        if op == "equal":
            continue
        old_tokens, new_tokens = _tokenize(old), _tokenize(new)
        before = "".join(old_tokens[max(0, a1 - 3):a1])
        after = "".join(old_tokens[a2:a2 + 3])
        hunk_id = _digest(f"{reference.match_key}\0{op}\0{a1}\0{a2}\0{b1}\0{b2}\0{old}\0{new}".encode())[:24]
        risks = sorted(set((base.risks if base else []) + (revised.risks if revised else [])))
        hunks.append(Hunk(hunk_id, reference.block_id, reference.match_key, author, op,
                          "".join(old_tokens[a1:a2]), "".join(new_tokens[b1:b2]), before, after, risks))
    if not hunks and base and revised and base.structure_fingerprint != revised.structure_fingerprint:
        hunks.append(Hunk(_digest(f"structure\0{reference.match_key}\0{base.structure_fingerprint}\0{revised.structure_fingerprint}".encode())[:24],
                          reference.block_id, reference.match_key, author, "structure",
                          base.structure_fingerprint, revised.structure_fingerprint, "", "",
                          sorted(set(base.risks + revised.risks))))
    if not hunks and base and revised and base.format_fingerprint != revised.format_fingerprint:
        hunks.append(Hunk(_digest(f"format\0{reference.match_key}\0{base.format_fingerprint}\0{revised.format_fingerprint}".encode())[:24],
                          reference.block_id, reference.match_key, author, "format",
                          base.format_fingerprint, revised.format_fingerprint, "", "",
                          sorted(set(base.risks + revised.risks))))
    return hunks


def compute_diff(base_path: str | Path, revised_path: str | Path, author: str) -> DiffResult:
    """Compute deterministic text hunks anchored to paragraph/table-cell blocks."""
    base_file, revised_file = Path(base_path), Path(revised_path)
    base_check, revised_check = validate_docx(base_file), validate_docx(revised_file)
    if not base_check.valid or not revised_check.valid:
        raise ValueError(f"unsafe_docx: base={base_check.errors}; revised={revised_check.errors}")
    base_blocks, _, _ = _load_blocks(base_file)
    revised_blocks, _, _ = _load_blocks(revised_file)
    hunks: list[Hunk] = []
    unchanged = 0
    for old, new in _matching(base_blocks, revised_blocks).values():
        if (old and new and old.text == new.text and old.structure_fingerprint == new.structure_fingerprint
                and old.format_fingerprint == new.format_fingerprint and old.risks == new.risks):
            unchanged += 1
            continue
        hunks.extend(_make_hunks(old, new, author))
    warnings = sorted(set(base_check.warnings + revised_check.warnings))
    return DiffResult(author, base_check.sha256 or "", revised_check.sha256 or "", hunks, unchanged, warnings, base_blocks, revised_blocks)


def _decision(value: Any) -> bool:
    if isinstance(value, Mapping):
        value = value.get("decision", value.get("status"))
    return value is True or (isinstance(value, str) and value.lower() in {"accept", "accepted", "approve"})


def _selected_text(base_text: str, revised_text: str, hunks: list[Hunk], decisions: Mapping[str, Any]) -> str:
    """Apply selected token opcodes to base text, retaining non-selected source text."""
    # Hunk offsets are not stored intentionally; identify each fragment in the ordered token diff.
    old_tokens, new_tokens = _tokenize(base_text), _tokenize(revised_text)
    matcher = SequenceMatcher(a=old_tokens, b=new_tokens, autojunk=False)
    hunk_by_signature: dict[tuple[str, str, str], list[Hunk]] = {}
    for hunk in hunks:
        hunk_by_signature.setdefault((hunk.operation, hunk.base_text, hunk.revised_text), []).append(hunk)
    out: list[str] = []
    for op, a1, a2, b1, b2 in matcher.get_opcodes():
        if op == "equal":
            out.extend(old_tokens[a1:a2])
            continue
        candidates = hunk_by_signature.get((op, "".join(old_tokens[a1:a2]), "".join(new_tokens[b1:b2])), [])
        hunk = candidates.pop(0) if candidates else None
        if hunk and _decision(decisions.get(hunk.hunk_id)):
            out.extend(new_tokens[b1:b2])
        else:
            out.extend(old_tokens[a1:a2])
    return "".join(out)


_MATH_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
# Anything in this set is inline or relationship-bearing content that a text-only
# rebuild would silently destroy (a dropped image is a lost figure, not a lost word).
_UNSAFE_REBUILD_TAGS = {
    "drawing", "pict", "object", "chart", "fldSimple", "instrText", "hyperlink", "sdt",
    "ins", "del", "moveFrom", "moveTo", "commentRangeStart", "commentRangeEnd",
    "commentReference", "footnoteReference", "endnoteReference",
    "br", "cr", "tab", "noBreakHyphen", "softHyphen", "sym",
}


def _unsafe_rebuild_reason(element: ET.Element) -> str | None:
    """Return the local name of the first child a text rebuild would destroy."""
    for node in element.iter():
        local = node.tag.rsplit("}", 1)[-1]
        if local in _UNSAFE_REBUILD_TAGS or node.tag.startswith(_MATH_NS):
            return local
    return None


def _set_paragraph_text(paragraph: ET.Element, text: str) -> None:
    """Replace paragraph contents while preserving pPr; used only for simple blocks."""
    ppr = paragraph.find("w:pPr", NS)
    for child in list(paragraph):
        if child is not ppr:
            paragraph.remove(child)
    if text:
        run = ET.SubElement(paragraph, f"{{{W}}}r")
        node = ET.SubElement(run, f"{{{W}}}t")
        if text[:1].isspace() or text[-1:].isspace():
            node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        node.text = text


def _locate(parts: Mapping[str, ET.Element], target: ET.Element) -> tuple[ET.Element, int] | None:
    """Find ``target``'s parent element and its index among that parent's children."""
    for root in parts.values():
        for parent in root.iter():
            for index, child in enumerate(list(parent)):
                if child is target:
                    return parent, index
    return None


def _replace_with_clone(target: ET.Element, source: ET.Element, roots: dict[str, ET.Element]) -> None:
    for root in roots.values():
        for parent in root.iter():
            children = list(parent)
            if target in children:
                parent.insert(children.index(target), copy.deepcopy(source))
                parent.remove(target)
                return


def _write_docx(source: Path, parts: dict[str, ET.Element], output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as rewritten:
        for info in original.infolist():
            data = original.read(info.filename)
            if info.filename in parts:
                data = ET.tostring(parts[info.filename], encoding="utf-8", xml_declaration=True)
            rewritten.writestr(info, data)
    os.replace(temp, output)
    return output


def _insert_clone(base_parts: Mapping[str, ET.Element], revised_parts: Mapping[str, ET.Element],
                  new_element: ET.Element, anchor_of: dict[int, ET.Element]) -> ET.Element | None:
    """Insert an accepted new block next to the nearest sibling that also exists in base.

    ``anchor_of`` maps ``id(revised element)`` to the element standing in for it in the
    output tree, including clones inserted earlier in this same pass, so several
    consecutive new paragraphs keep their document order.

    Returns the clone that now lives in ``base_parts`` — callers that need to annotate the
    inserted copy (for example to wrap it in ``w:ins``) must use this object, since the
    tree holds a copy rather than ``new_element`` itself.  Returns ``None`` when no anchor
    sibling exists (for example a whole new table), because guessing a position there is
    exactly how content ends up in the wrong place.
    """
    located = _locate(revised_parts, new_element)
    if not located:
        return None
    parent, index = located
    siblings = list(parent)
    clone: ET.Element | None = None
    for sibling in reversed(siblings[:index]):
        target = anchor_of.get(id(sibling))
        found = _locate(base_parts, target) if target is not None else None
        if found:
            clone = copy.deepcopy(new_element)
            found[0].insert(found[1] + 1, clone)
            break
    if clone is None:
        for sibling in siblings[index + 1:]:
            target = anchor_of.get(id(sibling))
            found = _locate(base_parts, target) if target is not None else None
            if found:
                clone = copy.deepcopy(new_element)
                found[0].insert(found[1], clone)
                break
    if clone is None:
        return None
    anchor_of[id(new_element)] = clone
    return clone


def _remove_block(base_parts: Mapping[str, ET.Element], element: ET.Element) -> bool:
    located = _locate(base_parts, element)
    if not located:
        return False
    parent, _ = located
    parent.remove(element)
    return True


def apply_decisions(base_path: str | Path, revised_path: str | Path, diff_result: DiffResult,
                    decisions: Mapping[str, Any], output_path: str | Path) -> ApplyResult:
    """Create clean base + accepted hunk output. Unrelated OOXML members stay untouched.

    Accepted changes that cannot be applied safely are reported as :class:`ApplyConflict`
    instead of being skipped, so the caller can refuse to mark the submission reviewed
    rather than silently publishing a document that dropped the teacher's decision.
    """
    base_file, revised_file, output = Path(base_path), Path(revised_path), Path(output_path)
    if _file_digest(base_file) != diff_result.base_sha256 or _file_digest(revised_file) != diff_result.revised_sha256:
        raise ValueError("input_hash_does_not_match_diff")
    base_blocks, base_elements, base_parts = _load_blocks(base_file)
    revised_blocks, revised_elements, revised_parts = _load_blocks(revised_file)
    base_by_key, revised_by_key = {b.match_key: b for b in base_blocks}, {b.match_key: b for b in revised_blocks}
    # Both element maps preserve document order, so this gives a stable walk order that
    # keeps consecutive insertions where the reviewer put them.
    revised_sequence = {key: index for index, key in enumerate(revised_elements)}
    base_sequence = {key: index for index, key in enumerate(base_elements)}
    anchor_of = {id(revised_elements[key]): base_elements[key] for key in base_elements if key in revised_elements}
    by_key: dict[str, list[Hunk]] = {}
    for hunk in diff_result.hunks:
        by_key.setdefault(hunk.match_key, []).append(hunk)
    applied: list[str] = []
    rejected: list[str] = []
    conflicts: list[ApplyConflict] = []
    warnings: list[str] = []

    def _order(key: str) -> tuple[int, int]:
        return (0, revised_sequence[key]) if key in revised_sequence else (1, base_sequence.get(key, 0))

    for key, hunks in sorted(by_key.items(), key=lambda item: _order(item[0])):
        old, new = base_by_key.get(key), revised_by_key.get(key)
        accepted_ids = {h.hunk_id for h in hunks if _decision(decisions.get(h.hunk_id))}
        accepted = [h for h in hunks if h.hunk_id in accepted_ids]
        applied.extend(sorted(accepted_ids))
        rejected.extend(sorted(h.hunk_id for h in hunks if h.hunk_id not in accepted_ids))
        if not accepted:
            continue
        if old and not new:
            element = base_elements.get(key)
            if element is not None and _remove_block(base_parts, element):
                warnings.append(f"deleted_block:{key}")
            else:
                conflicts.append(ApplyConflict(key, old.part, old.anchor, "delete",
                                               "cannot_locate_block_for_deletion",
                                               "无法在原文中定位该段落，删除未执行",
                                               sorted(accepted_ids)))
            continue
        if new and not old:
            if _insert_clone(base_parts, revised_parts, revised_elements[key], anchor_of) is not None:
                warnings.append(f"inserted_block:{key}")
            else:
                conflicts.append(ApplyConflict(key, new.part, new.anchor, "insert",
                                               "cannot_determine_insert_position",
                                               "无法确定新增段落的父节点或插入位置，请人工处理",
                                               sorted(accepted_ids)))
            continue
        if not old or not new:
            continue
        if any(h.operation == "structure" for h in hunks):
            conflicts.append(ApplyConflict(key, new.part, new.anchor, "structure",
                                           "high_risk_structure_change_requires_manual",
                                           "该段落含图片/公式/图表/域等高风险对象，无法自动合并",
                                           sorted(accepted_ids)))
            continue
        text_hunks = [h for h in hunks if h.operation not in {"format", "structure"}]
        if not text_hunks:
            # Formatting-only change: replacing the whole block with the revised clone is
            # the only safe application, so refuse it on blocks the engine already distrusts.
            if old.risks or new.risks:
                conflicts.append(ApplyConflict(key, new.part, new.anchor, "format",
                                               "high_risk_format_change_requires_manual",
                                               "高风险段落不支持自动套用格式变更",
                                               sorted(accepted_ids)))
                continue
            _replace_with_clone(base_elements[key], revised_elements[key], base_parts)
            warnings.append(f"format_change_applied:{key}")
            continue
        selected = _selected_text(old.text, new.text, text_hunks, decisions)
        if selected == old.text:
            continue
        if selected == new.text and not old.risks and not new.risks:
            _replace_with_clone(base_elements[key], revised_elements[key], base_parts)
            continue
        unsafe = _unsafe_rebuild_reason(base_elements[key]) or _unsafe_rebuild_reason(revised_elements[key])
        if unsafe:
            conflicts.append(ApplyConflict(key, new.part, new.anchor, "complex_edit",
                                           "fragment_edit_on_complex_block_requires_manual",
                                           f"该段落含 {unsafe} 等对象，片段级改写会破坏它，请人工处理",
                                           sorted(accepted_ids)))
            continue
        _set_paragraph_text(base_elements[key], selected)
        warnings.append(f"fragment_applied:{key}")

    _write_docx(base_file, base_parts, output)
    return ApplyResult(str(output), sorted(set(applied)), sorted(set(rejected)), conflicts, sorted(set(warnings)))


def _all_accept(diff: DiffResult) -> dict[str, str]:
    return {hunk.hunk_id: "accept" for hunk in diff.hunks}


def merge_contributions(
    base_path: str | Path,
    contributions: list[tuple[str | Path, str]],
    output_path: str | Path,
    resolutions: Mapping[str, str] | None = None,
) -> MergeResult:
    """Merge changes to distinct paragraph/cell blocks; make same-block changes explicit conflicts."""
    base_file, output = Path(base_path), Path(output_path)
    base_check = validate_docx(base_file)
    if not base_check.valid:
        raise ValueError(f"unsafe_docx: {base_check.errors}")
    current = base_file
    applied: list[Contribution] = []
    conflicts: list[MergeConflict] = []
    claimed: dict[str, tuple[str, str, str]] = {}
    resolutions = resolutions or {}
    for number, (candidate_path, author) in enumerate(contributions):
        candidate = Path(candidate_path)
        diff = compute_diff(base_file, candidate, author)
        changed = sorted({h.match_key for h in diff.hunks})
        safe_keys: set[str] = set()
        base_by_key = {b.match_key: b for b in diff.base_blocks}
        revised_by_key = {b.match_key: b for b in diff.revised_blocks}
        for key in changed:
            existing = claimed.get(key)
            incoming = revised_by_key.get(key)
            base_block = base_by_key.get(key)
            if existing:
                current_author, current_text, _ = existing
                chosen = resolutions.get(key)
                if chosen == current_author:
                    continue
                if chosen == author and base_block and incoming and not base_block.risks and not incoming.risks:
                    safe_keys.add(key)
                    claimed[key] = (author, incoming.text, str(candidate))
                    continue
                conflicts.append(MergeConflict(
                    _digest(f"{key}\0{current_author}\0{author}".encode())[:24], key,
                    base_block.part if base_block else "unknown", base_block.text if base_block else "",
                    current_text, incoming.text if incoming else "", current_author, author))
                continue
            if not base_block or not incoming or base_block.risks or incoming.risks:
                # Insertions/deletions and complex blocks are intentionally conflict-only in v1.
                conflicts.append(MergeConflict(_digest(f"risk\0{key}\0{author}".encode())[:24], key,
                    (base_block or incoming).part, base_block.text if base_block else "", "",
                    incoming.text if incoming else "", "", author, "high_risk_or_structural_change"))
                continue
            safe_keys.add(key)
            claimed[key] = (author, incoming.text, str(candidate))
        safe_hunks: dict[str, str] = {}
        overlay_diff = compute_diff(current, candidate, author)
        for hunk in overlay_diff.hunks:
            if hunk.match_key in safe_keys:
                safe_hunks[hunk.hunk_id] = "accept"
        if safe_hunks:
            staged = output.with_name(f".{output.stem}.merge-{number}.docx")
            # Diff against the accumulated document, but accept only the structural
            # blocks selected above. Candidate differences in previously merged
            # blocks are therefore retained unless an explicit resolution chose it.
            apply_decisions(current, candidate, overlay_diff, safe_hunks, staged)
            current = staged
        applied.append(Contribution(author, str(candidate), sorted(safe_hunks), sorted(safe_keys)))
    if current == base_file:
        _write_docx(base_file, _read_xml_parts(base_file), output)
    elif current != output:
        output.parent.mkdir(parents=True, exist_ok=True)
        os.replace(current, output)
    return MergeResult(str(output), applied, conflicts, base_check.warnings)


def _redline_paragraph(paragraph: ET.Element, old: str, new: str, author: str, revision_id: int) -> int:
    ppr = paragraph.find("w:pPr", NS)
    for child in list(paragraph):
        if child is not ppr:
            paragraph.remove(child)
    old_tokens, new_tokens = _tokenize(old), _tokenize(new)
    # No `w:date`: it is optional in OOXML, and stamping `now()` here would make two
    # runs over identical input produce different bytes — and therefore two different
    # content-addressed versions for the same redline. Word fills in the date it
    # displays itself when it opens the file.
    for operation, a1, a2, b1, b2 in SequenceMatcher(a=old_tokens, b=new_tokens, autojunk=False).get_opcodes():
        if operation == "equal":
            _append_run(paragraph, "".join(old_tokens[a1:a2]))
        else:
            # A replacement needs two revisions, and every `w:id` in the document has
            # to be distinct, so the deletion and the insertion cannot share one.
            if a1 != a2:
                deleted = ET.SubElement(paragraph, f"{{{W}}}del", {f"{{{W}}}id": str(revision_id), f"{{{W}}}author": author})
                _append_run(deleted, "".join(old_tokens[a1:a2]), deleted=True)
                revision_id += 1
            if b1 != b2:
                inserted = ET.SubElement(paragraph, f"{{{W}}}ins", {f"{{{W}}}id": str(revision_id), f"{{{W}}}author": author})
                _append_run(inserted, "".join(new_tokens[b1:b2]))
                revision_id += 1
    return revision_id


def _append_run(parent: ET.Element, text: str, deleted: bool = False) -> None:
    if not text:
        return
    run = ET.SubElement(parent, f"{{{W}}}r")
    tag = "delText" if deleted else "t"
    node = ET.SubElement(run, f"{{{W}}}{tag}")
    if text[:1].isspace() or text[-1:].isspace():
        node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    node.text = text


def _mark_paragraph_mark(paragraph: ET.Element, tag: str, author: str, revision_id: int) -> int:
    """Flag the paragraph mark itself with ``w:ins`` / ``w:del`` under ``w:pPr/w:rPr``.

    Marking only the runs is not enough: without this, Word treats an inserted paragraph
    as text added to the *previous* paragraph, so accepting the change would merge two
    paragraphs that the author meant to keep apart.
    """
    ppr = paragraph.find("w:pPr", NS)
    if ppr is None:
        ppr = ET.Element(f"{{{W}}}pPr")
        paragraph.insert(0, ppr)
    rpr = ppr.find("w:rPr", NS)
    if rpr is None:
        rpr = ET.SubElement(ppr, f"{{{W}}}rPr")
    ET.SubElement(rpr, f"{{{W}}}{tag}", {f"{{{W}}}id": str(revision_id), f"{{{W}}}author": author})
    return revision_id + 1


def _redline_inserted_paragraph(paragraph: ET.Element, author: str, revision_id: int) -> int:
    """Wrap every run of a wholly new paragraph in ``w:ins``."""
    for child in list(paragraph):
        if child.tag == f"{{{W}}}pPr":
            continue
        paragraph.remove(child)
        inserted = ET.SubElement(paragraph, f"{{{W}}}ins", {f"{{{W}}}id": str(revision_id), f"{{{W}}}author": author})
        inserted.append(child)
        revision_id += 1
    return _mark_paragraph_mark(paragraph, "ins", author, revision_id)


def _redline_deleted_paragraph(paragraph: ET.Element, author: str, revision_id: int) -> int:
    """Wrap a whole removed paragraph's text in ``w:del`` / ``w:delText``."""
    for child in list(paragraph):
        if child.tag == f"{{{W}}}pPr":
            continue
        paragraph.remove(child)
        deleted = ET.SubElement(paragraph, f"{{{W}}}del", {f"{{{W}}}id": str(revision_id), f"{{{W}}}author": author})
        # OOXML only allows `w:delText` inside a deletion; leaving a `w:t` behind (for
        # example one nested in a hyperlink) makes Word report the file as corrupt.
        for node in child.iter():
            if node.tag == f"{{{W}}}t":
                node.tag = f"{{{W}}}delText"
        deleted.append(child)
        revision_id += 1
    return _mark_paragraph_mark(paragraph, "del", author, revision_id)


def generate_redline(base: str | Path, revised: str | Path, author: str, output: str | Path) -> RedlineResult:
    """Write a native-track-changes DOCX covering in-place edits, insertions and deletions.

    Every change we cannot express as a revision (a whole new table, or a block carrying
    drawings / equations / fields) is reported in ``warnings`` instead of being dropped
    quietly, so the caller can tell the teacher the redline is incomplete.
    """
    base_file, revised_file, output_file = Path(base), Path(revised), Path(output)
    diff = compute_diff(base_file, revised_file, author)
    base_blocks, base_elements, base_parts = _load_blocks(base_file)
    revised_blocks, revised_elements, revised_parts = _load_blocks(revised_file)
    base_by_key = {block.match_key: block for block in base_blocks}
    revised_by_key = {block.match_key: block for block in revised_blocks}
    warnings: list[str] = []
    revision_id = 1
    # Mirrors `apply_decisions`: shared blocks map straight across, and each inserted clone
    # is registered so a run of consecutive new paragraphs keeps its document order.
    anchor_of = {id(revised_elements[key]): base_elements[key] for key in base_elements if key in revised_elements}

    for key in revised_elements:
        if key in base_by_key:
            continue
        new = revised_by_key[key]
        if new.kind != "paragraph":
            warnings.append(f"not_redlined_insert:{key}")
            continue
        clone = _insert_clone(base_parts, revised_parts, revised_elements[key], anchor_of)
        if clone is None:
            warnings.append(f"not_redlined_insert:{key}")
            continue
        revision_id = _redline_inserted_paragraph(clone, author, revision_id)

    for key, old in base_by_key.items():
        new = revised_by_key.get(key)
        if new is None:
            if old.kind != "paragraph":
                warnings.append(f"not_redlined_delete:{key}")
                continue
            revision_id = _redline_deleted_paragraph(base_elements[key], author, revision_id)
            continue
        if old.text == new.text:
            continue
        if old.risks or new.risks:
            warnings.append(f"high_risk_block_not_redlined:{key}")
            continue
        revision_id = _redline_paragraph(base_elements[key], old.text, new.text, author, revision_id)
    _write_docx(base_file, base_parts, output_file)
    return RedlineResult(str(output_file), diff, "builtin_ooxml", warnings)


# --------------------------------------------------------------------------- #
# Deployment self-check                                                        #
# --------------------------------------------------------------------------- #

#: Everything the API calls by name. A deployment is only usable when all of these
#: exist *and* behave the way the API assumes.
REQUIRED_CALLABLES = (
    "apply_decisions",
    "compute_diff",
    "generate_redline",
    "merge_contributions",
    "validate_docx",
)


def verify_contract() -> list[str]:
    """Return the ways this copy of the engine would break the API; empty means OK.

    Deliberately *behavioural* rather than a version comparison. A stale copy that
    still reports the same version number is exactly the failure this guards
    against: a deployment once reported `engine_available: true` while
    `apply_decisions()` still returned a bare `Path`, so every "完成审阅" click died
    with `AttributeError: 'WindowsPath' object has no attribute
    'needs_manual_review'`. Comparing numbers would not have caught it; probing the
    objects the API actually reads does.
    """
    problems: list[str] = []

    for name in REQUIRED_CALLABLES:
        if not callable(globals().get(name)):
            problems.append(f"缺少 {name}()")

    applied = ApplyResult(output_path="")
    if not isinstance(getattr(applied, "needs_manual_review", None), bool):
        problems.append("apply_decisions() 的返回值没有 needs_manual_review 布尔属性")
    if not isinstance(getattr(applied, "conflicts", None), list):
        problems.append("apply_decisions() 的返回值没有 conflicts 列表")
    if not isinstance(getattr(applied, "warnings", None), list):
        problems.append("apply_decisions() 的返回值没有 warnings 列表")

    redline = RedlineResult(output_path="", diff=None, engine="contract-probe")
    if not isinstance(getattr(redline, "warnings", None), list):
        problems.append("generate_redline() 的返回值没有 warnings 列表")

    return problems


def engine_info() -> dict[str, Any]:
    """Identity of *this* file, for `/healthz` and the install-time self-check."""
    problems = verify_contract()
    return {
        "version": ENGINE_VERSION,
        "contract": ENGINE_CONTRACT_VERSION,
        "file": __file__,
        "compatible": not problems,
        "problems": problems,
    }
