---
name: testing-strategy
description: >
  测试策略设计:测试金字塔、覆盖取舍,该写哪些测试与不该写哪些。
whenToUse: >
  评审测试设计、判断覆盖够不够、定测试计划时。
version: 0.0.1
---

# Testing Strategy

> **随包说明**:本技能随 `dsh-plugin-dev-workflow` 一起发布(包内 `skills/testing-strategy/`),
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

Design effective testing strategies balancing coverage, speed, and maintenance.

## Testing Pyramid

```
        /  E2E  \         Few, slow, high confidence
       / Integration \     Some, medium speed
      /    Unit Tests  \   Many, fast, focused
```

## Strategy by Component Type

- **API endpoints**: Unit tests for business logic, integration tests for HTTP layer, contract tests for consumers
- **Data pipelines**: Input validation, transformation correctness, idempotency tests
- **Frontend**: Component tests, interaction tests, visual regression, accessibility
- **Infrastructure**: Smoke tests, chaos engineering, load tests

## What to Cover

Focus on: business-critical paths, error handling, edge cases, security boundaries, data integrity.

Skip: trivial getters/setters, framework code, one-off scripts.

## Output

Produce a test plan with: what to test, test type for each area, coverage targets, and example test cases. Identify gaps in existing coverage.
