---
name: python-error-handling
description: >
  Python 错误处理:输入校验、异常层级与部分失败的处理。
whenToUse: >
  写校验层、定义异常类型、处理批量或部分失败时。
version: 0.0.1
---

# Python Error Handling

> **随包说明**:本技能随 `dsh-plugin-dev-workflow` 一起发布(包内 `skills/python-error-handling/`),
> 只在**已激活**的 dev-workflow 项目里出现在 DSH 技能目录中。用 `skill` 工具加载它时给出的
> "Base directory for this skill" 就是它的根目录,文中的相对路径(`references/`、`scripts/`、
> `templates/`、`assets/`)都相对那里解析。
>
> **工具名对照**(本文或许带着别的工具链的写法,在 DSH 里对应的是):`Read`/`read_file` → `read`,
> `Write`/`write_file` → `write`,`Edit` → `edit`,`Bash`/`terminal` → `pwsh`,
> `Glob`/`Grep`/`search_files` → `glob`/`grep`,`TodoWrite` → `todo_write`,
> `Task`/`delegate_task` → `subagent`,`web_extract` → `web_fetch`。
> 文中提到的脚本与模板**只有随包时才存在** —— 加载后先照 Base directory 核一眼,没有的步骤跳过,
> 或按文中原则自行实现,不要到别处去找。

Build robust Python applications with proper input validation, meaningful exceptions, and graceful failure handling. Good error handling makes debugging easier and systems more reliable.

## When to Use This Skill

- Validating user input and API parameters
- Designing exception hierarchies for applications
- Handling partial failures in batch operations
- Converting external data to domain types
- Building user-friendly error messages
- Implementing fail-fast validation patterns

## Core Concepts

### 1. Fail Fast

Validate inputs early, before expensive operations. Report all validation errors at once when possible.

### 2. Meaningful Exceptions

Use appropriate exception types with context. Messages should explain what failed, why, and how to fix it.

### 3. Partial Failures

In batch operations, don't let one failure abort everything. Track successes and failures separately.

### 4. Preserve Context

Chain exceptions to maintain the full error trail for debugging.

## Quick Start

```python
def fetch_page(url: str, page_size: int) -> Page:
    if not url:
        raise ValueError("'url' is required")
    if not 1 <= page_size <= 100:
        raise ValueError(f"'page_size' must be 1-100, got {page_size}")
    # Now safe to proceed...
```

## Fundamental Patterns

### Pattern 1: Early Input Validation

Validate all inputs at API boundaries before any processing begins.

```python
def process_order(
    order_id: str,
    quantity: int,
    discount_percent: float,
) -> OrderResult:
    """Process an order with validation."""
    # Validate required fields
    if not order_id:
        raise ValueError("'order_id' is required")

    # Validate ranges
    if quantity <= 0:
        raise ValueError(f"'quantity' must be positive, got {quantity}")

    if not 0 <= discount_percent <= 100:
        raise ValueError(
            f"'discount_percent' must be 0-100, got {discount_percent}"
        )

    # Validation passed, proceed with processing
    return _process_validated_order(order_id, quantity, discount_percent)
```

### Pattern 2: Convert to Domain Types Early

Parse strings and external data into typed domain objects at system boundaries.

```python
from enum import Enum

class OutputFormat(Enum):
    JSON = "json"
    CSV = "csv"
    PARQUET = "parquet"

def parse_output_format(value: str) -> OutputFormat:
    """Parse string to OutputFormat enum.

    Args:
        value: Format string from user input.

    Returns:
        Validated OutputFormat enum member.

    Raises:
        ValueError: If format is not recognized.
    """
    try:
        return OutputFormat(value.lower())
    except ValueError:
        valid_formats = [f.value for f in OutputFormat]
        raise ValueError(
            f"Invalid format '{value}'. "
            f"Valid options: {', '.join(valid_formats)}"
        )

# Usage at API boundary
def export_data(data: list[dict], format_str: str) -> bytes:
    output_format = parse_output_format(format_str)  # Fail fast
    # Rest of function uses typed OutputFormat
    ...
```

### Pattern 3: Pydantic for Complex Validation

Use Pydantic models for structured input validation with automatic error messages.

```python
from pydantic import BaseModel, Field, field_validator

class CreateUserInput(BaseModel):
    """Input model for user creation."""

    email: str = Field(..., min_length=5, max_length=255)
    name: str = Field(..., min_length=1, max_length=100)
    age: int = Field(ge=0, le=150)

    @field_validator("email")
    @classmethod
    def validate_email_format(cls, v: str) -> str:
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email format")
        return v.lower()

    @field_validator("name")
    @classmethod
    def normalize_name(cls, v: str) -> str:
        return v.strip().title()

# Usage
try:
    user_input = CreateUserInput(
        email="user@example.com",
        name="john doe",
        age=25,
    )
except ValidationError as e:
    # Pydantic provides detailed error information
    print(e.errors())
```

### Pattern 4: Map Errors to Standard Exceptions

Use Python's built-in exception types appropriately, adding context as needed.

| Failure Type | Exception | Example |
|--------------|-----------|---------|
| Invalid input | `ValueError` | Bad parameter values |
| Wrong type | `TypeError` | Expected string, got int |
| Missing item | `KeyError` | Dict key not found |
| Operational failure | `RuntimeError` | Service unavailable |
| Timeout | `TimeoutError` | Operation took too long |
| File not found | `FileNotFoundError` | Path doesn't exist |
| Permission denied | `PermissionError` | Access forbidden |

```python
# Good: Specific exception with context
raise ValueError(f"'page_size' must be 1-100, got {page_size}")

# Avoid: Generic exception, no context
raise Exception("Invalid parameter")
```

## Detailed worked examples and patterns

Detailed sections (starting with `## Advanced Patterns`) live in `references/details.md`. Read that file when the navigation summary above is insufficient.

## Best Practices Summary

1. **Validate early** - Check inputs before expensive operations
2. **Use specific exceptions** - `ValueError`, `TypeError`, not generic `Exception`
3. **Include context** - Messages should explain what, why, and how to fix
4. **Convert types at boundaries** - Parse strings to enums/domain types early
5. **Chain exceptions** - Use `raise ... from e` to preserve debug info
6. **Handle partial failures** - Don't abort batches on single item errors
7. **Use Pydantic** - For complex input validation with structured errors
8. **Document failure modes** - Docstrings should list possible exceptions
9. **Log with context** - Include IDs, counts, and other debugging info
10. **Test error paths** - Verify exceptions are raised correctly
