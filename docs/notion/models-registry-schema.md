# Models registry (Notion database) — schema for CIP / SAP

Reference for the **CIP Models / Collections** database in Notion ([open](https://www.notion.so/f1f635c18de8438eb696989dbd2104db)). Extend or edit columns there as needed; Feature Summaries links via **Models (registry)**.

## Purpose

- **Single source of truth** for Firestore paths, Swift type names, and links to canonical code (`models.swift`, `iOS App/Data/Models`).
- **Constrains Notion AI** when writing Feature Summaries: prefer **relation** to registry rows instead of inventing collection strings.

### How this differs from [Model Fields](https://www.notion.so/veamstudios/20d069083a038092b5bff7e9eb206193)

| Database | Granularity | Why it feels “full” |
|----------|-------------|---------------------|
| **Model Fields** | **Field-level** — each row is a property (e.g. `Inspection.title`, `Item.answer_type`) with a **Model** select | Many rows; great for **schema of fields** |
| **CIP Models / Collections** (this registry) | **Type / collection-level** — one row per domain model (aligned with the same **Model** names) | Fewer rows; each row should carry **Firestore path + canonical code link** |

To make the registry **as useful as Model Fields for day-to-day work**, keep **one registry row per Model Fields taxonomy value** (Action, Inspection, User, …), fill **Firestore path / collection** from verified code, and use **Notes** (or the agent) to point readers at Model Fields for **field-level** detail. Add new rows in Notion when new collections/types appear.

## Suggested properties

| Property | Type | Notes |
|----------|------|--------|
| **Name** | Title | Human-readable concept (e.g. “Inspection report PDF export”). |
| **Product** | Relation → Products | CIP vs SAP (or multi-select if one row serves both). |
| **Firestore path / collection** | Text or URL | Single canonical path or collection id string. |
| **Swift type(s)** | Text or multi-select | Domain type names as used in code. |
| **Canonical code link** | URL | Permalink to [`ChecklistInspectorPro-Models` `ios/models.swift`](https://github.com/VeamStudios/ChecklistInspectorPro-Models/blob/main/ios/models.swift), or to a file under [`ChecklistInspectorPro-iOS` `iOS App/Data/Models`](https://github.com/VeamStudios/ChecklistInspectorPro-iOS/tree/main/iOS%20App/Data/Models), with `#L` line anchor when useful. |
| **Notes** | Text | Constraints, versioning, offline/sync caveats. |

## Feature Summaries database

- Property **Models (registry)** — **Relation** to this database (**Allow multiple**).
- Optional: **Rollup** from relation (e.g. join Firestore paths) for quick scanning.

## Agent rules (summary)

- When documenting **Models** on a Feature Summary page, **select** existing registry rows that apply.
- **Create** a new registry row only when a new collection/type appears and you can cite a Proposal, PR, or canonical GitHub file.
- If the Proposal text conflicts with the registry, **registry wins**; record the discrepancy under **Developer notes** or **Logs**.

## Reference links

- [Proposals database](https://www.notion.so/veamstudios/2ca691667ea34ddfabee572644ce8290)
- [Feature Summaries database](https://www.notion.so/veamstudios/342069083a03803582efce5c9bc4163d)
- **CIP Models / Collections** (registry): [open in Notion](https://www.notion.so/f1f635c18de8438eb696989dbd2104db) — created under **Utility**; Feature Summaries includes **Models (registry)** → this database.
- Existing **[Model Fields](https://www.notion.so/veamstudios/20d069083a038092b5bff7e9eb206193)** database is separate (field-level model taxonomy); keep using it alongside the registry if needed.

Share **CIP Models / Collections** with the same Notion integration used for Proposals / Feature Summaries automation if it cannot edit the registry yet.
