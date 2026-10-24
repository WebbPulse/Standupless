"""Jira's Atlassian Document Format as markdown, deterministically and without any model.

Jira Cloud's REST API v3 answers descriptions and comments as an ADF tree: block
nodes such as paragraphs, headings, lists, code blocks, quotes, panels and
tables holding inline text with marks. `to_markdown` walks that tree and writes
the markdown a Standupless issue or comment renders. Every node type ADF defines
has a rendering; an unknown one renders its children, so new Jira content
degrades to its text rather than vanishing. Media cannot be carried, since the
files stay in Jira, so an attachment becomes a short placeholder. A plain
string, which the older API returns, is passed through unchanged.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

MAX_DEPTH = 40
"""How deep the walk follows nesting, so a malformed tree cannot recurse without end."""

PANEL_LABELS: dict[str, str] = {
    "info": "Info",
    "note": "Note",
    "warning": "Warning",
    "error": "Error",
    "success": "Success",
    "tip": "Tip",
}


def to_markdown(value: Any) -> str:
    """One ADF document, or a plain string, as markdown with surrounding blank lines trimmed."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, dict):
        return ""
    return _blocks(_children(value), 0).strip()


def _children(node: dict[str, Any]) -> list[dict[str, Any]]:
    """A node's content, keeping only well formed child nodes."""
    content = node.get("content")
    if not isinstance(content, list):
        return []
    return [child for child in content if isinstance(child, dict)]


def _attrs(node: dict[str, Any]) -> dict[str, Any]:
    """A node's attributes, or none."""
    attrs = node.get("attrs")
    return attrs if isinstance(attrs, dict) else {}


def _blocks(nodes: list[dict[str, Any]], depth: int) -> str:
    """A run of block nodes, separated by blank lines."""
    parts = [_block(node, depth) for node in nodes]
    return "\n\n".join(part for part in parts if part.strip())


def _block(node: dict[str, Any], depth: int) -> str:
    """One block node as markdown."""
    if depth > MAX_DEPTH:
        return ""
    kind = node.get("type")
    children = _children(node)
    attrs = _attrs(node)
    if kind == "paragraph":
        return _inline(children)
    if kind == "heading":
        level = attrs.get("level")
        hashes = "#" * (level if isinstance(level, int) and 1 <= level <= 6 else 1)
        return f"{hashes} {_inline(children)}".rstrip()
    if kind == "bulletList":
        return _list(children, depth, ordered=False, start=1)
    if kind == "orderedList":
        order = attrs.get("order")
        return _list(children, depth, ordered=True, start=order if isinstance(order, int) and order > 0 else 1)
    if kind == "taskList":
        return _tasks(children, depth)
    if kind == "decisionList":
        return "\n".join(f"- {_inline(_children(item))}" for item in children)
    if kind == "codeBlock":
        language = str(attrs.get("language") or "").strip()
        text = "".join(str(child.get("text") or "") for child in children)
        fence = "````" if "```" in text else "```"
        return f"{fence}{language}\n{text}\n{fence}"
    if kind == "blockquote":
        return _quote(_blocks(children, depth + 1))
    if kind == "panel":
        label = PANEL_LABELS.get(str(attrs.get("panelType") or ""), "Note")
        return _quote(f"**{label}:** {_blocks(children, depth + 1)}")
    if kind == "rule":
        return "---"
    if kind == "table":
        return _table(children)
    if kind == "expand" or kind == "nestedExpand":
        title = str(attrs.get("title") or "").strip()
        body = _blocks(children, depth + 1)
        return f"**{title}**\n\n{body}" if title else body
    if kind in ("mediaSingle", "mediaGroup"):
        return "\n".join(_media(child) for child in children if child.get("type") == "media")
    if kind == "media":
        return _media(node)
    if kind in ("blockCard", "embedCard"):
        url = str(attrs.get("url") or "").strip()
        return f"<{url}>" if url.startswith(("https://", "http://")) else ""
    if kind in ("text", "hardBreak", "mention", "emoji", "inlineCard", "status", "date"):
        return _inline([node])
    return _blocks(children, depth + 1) if any(_is_block(child) for child in children) else _inline(children)


def _is_block(node: dict[str, Any]) -> bool:
    """Whether a node is a block rather than inline content."""
    return node.get("type") not in ("text", "hardBreak", "mention", "emoji", "inlineCard", "status", "date")


def _quote(text: str) -> str:
    """Text as a markdown block quote."""
    return "\n".join(f"> {line}".rstrip() for line in text.split("\n"))


def _indent(text: str, width: int) -> str:
    """Every line after the first indented to sit under a list marker."""
    lines = text.split("\n")
    return "\n".join([lines[0], *[f"{' ' * width}{line}" if line else line for line in lines[1:]]])


def _list(items: list[dict[str, Any]], depth: int, *, ordered: bool, start: int) -> str:
    """A bullet or numbered list, nested lists indented under their item."""
    lines = []
    for offset, item in enumerate(items):
        marker = f"{start + offset}." if ordered else "-"
        body = _list_item(item, depth)
        lines.append(f"{marker} {_indent(body, len(marker) + 1)}")
    return "\n".join(lines)


def _list_item(item: dict[str, Any], depth: int) -> str:
    """One list item's content, its paragraphs on one line each and nested lists beneath."""
    parts = [_block(child, depth + 1) for child in _children(item)]
    return "\n".join(part for part in parts if part.strip())


def _tasks(items: list[dict[str, Any]], depth: int) -> str:
    """A task list as markdown checkboxes."""
    lines = []
    for item in items:
        if item.get("type") == "taskList":
            lines.extend(f"  {line}" for line in _tasks(_children(item), depth + 1).split("\n"))
            continue
        done = str(_attrs(item).get("state") or "").upper() == "DONE"
        lines.append(f"- [{'x' if done else ' '}] {_inline(_children(item))}")
    return "\n".join(lines)


def _table(rows: list[dict[str, Any]]) -> str:
    """A table as a markdown pipe table, its first row as the header."""
    grid = []
    for row in rows:
        cells = [_cell(cell) for cell in _children(row)]
        if cells:
            grid.append(cells)
    if not grid:
        return ""
    width = max(len(cells) for cells in grid)
    grid = [cells + [""] * (width - len(cells)) for cells in grid]
    lines = [_row(grid[0]), _row(["---"] * width)]
    lines.extend(_row(cells) for cells in grid[1:])
    return "\n".join(lines)


def _cell(cell: dict[str, Any]) -> str:
    """One table cell's text on a single line, its pipes escaped."""
    text = _blocks(_children(cell), 1).replace("\n\n", " ").replace("\n", " ")
    return text.replace("|", "\\|").strip()


def _row(cells: list[str]) -> str:
    """One pipe table row."""
    return "| " + " | ".join(cells) + " |"


def _media(node: dict[str, Any]) -> str:
    """An attachment, which stays in Jira, as a placeholder naming it."""
    attrs = _attrs(node)
    name = str(attrs.get("alt") or attrs.get("filename") or "").strip()
    return f"_(Attachment in Jira: {name})_" if name else "_(Attachment in Jira)_"


def _inline(nodes: list[dict[str, Any]]) -> str:
    """A run of inline nodes as one markdown line."""
    return "".join(_inline_node(node) for node in nodes)


def _inline_node(node: dict[str, Any]) -> str:
    """One inline node as markdown."""
    kind = node.get("type")
    attrs = _attrs(node)
    if kind == "text":
        return _marked(str(node.get("text") or ""), node.get("marks"))
    if kind == "hardBreak":
        return "  \n"
    if kind == "mention":
        text = str(attrs.get("text") or "").strip()
        return text if text.startswith("@") else f"@{text or 'someone'}"
    if kind == "emoji":
        return str(attrs.get("text") or attrs.get("shortName") or "")
    if kind == "inlineCard":
        url = str(attrs.get("url") or "").strip()
        return f"<{url}>" if url.startswith(("https://", "http://")) else ""
    if kind == "status":
        return f"`{str(attrs.get('text') or '').strip()}`"
    if kind == "date":
        return _date(attrs.get("timestamp"))
    if kind == "media" or kind == "mediaInline":
        return _media(node)
    return _inline(_children(node))


def _date(value: Any) -> str:
    """An ADF date node's millisecond timestamp as `YYYY-MM-DD`."""
    try:
        return datetime.fromtimestamp(int(str(value)) / 1000, tz=UTC).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def _marked(text: str, marks: Any) -> str:
    """Text wrapped in the markdown its marks mean: code, bold, italic, strike, then a link around it all."""
    if not text or not isinstance(marks, list):
        return text
    kinds = {str(mark.get("type")): mark for mark in marks if isinstance(mark, dict)}
    if "code" in kinds:
        tick = "``" if "`" in text else "`"
        text = f"{tick}{text}{tick}"
    else:
        lead = text[: len(text) - len(text.lstrip())]
        trail = text[len(text.rstrip()) :]
        core = text.strip()
        if core:
            if "strike" in kinds:
                core = f"~~{core}~~"
            if "em" in kinds:
                core = f"*{core}*"
            if "strong" in kinds:
                core = f"**{core}**"
        text = f"{lead}{core}{trail}"
    link = kinds.get("link")
    if link is not None:
        href = str(_attrs(link).get("href") or "").strip()
        if href.startswith(("https://", "http://", "mailto:")):
            text = f"[{text}]({href})"
    return text
