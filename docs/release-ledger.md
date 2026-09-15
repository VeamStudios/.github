# Release process documentation

The team runbook lives in **Notion → Runbooks → [Feature releases and announcements](https://www.notion.so/3d5069083a0381b191e6fe4daa0899f5)**.

It covers the everyday flow, platform statuses, PR checklist and operator actions, with expandable detail. It is marked **Under Review**; the automation is not live.

| I need to… | Read |
|---|---|
| Follow the process or understand a status | [Notion runbook](https://www.notion.so/3d5069083a0381b191e6fe4daa0899f5) |
| Maintain CHANGELOG.md or the release integration | [Technical reference](release-ledger-reference.md) |
| Check rollout evidence, setup gaps or baseline candidates | [Technical rollout checklist](release-ledger-rollout.md) |

**[Work Items](https://www.notion.so/b8f865b23acb4c12922cf6d41045961c) are the source of truth** for feature scope, ownership and status. [Feature Status](https://app.notion.com/p/veamstudios/8249a8d4a94e4f8ab101aacd254b50ae?v=e5cfa701e3f24baea384abd7e48c6c87) is a filtered view of those same records. Linked Releases and Feature Availability records provide supporting evidence.

[Implementation Work Item](https://www.notion.so/3d4069083a038174982cc98d9c3b20cd)

Keep team-facing process instructions in the Notion runbook. Keep code contracts and technical validation evidence alongside the implementation here.

### Internal Work Item state

Machine evidence lives in Feature Availability records with `Scope = automation-state` and `Target = automation`. Keys are `automation/<work-item-id>/<kind>`: development per platform, Remote Config observations, or preserved release scope exceptions. Shared actions write these records and the Notion worker reads them. Keep these rows out of human availability views with `Scope != automation-state`. They do not generate Slack messages. Work Items only need the existing Dev Status and RC fields. Release wording comes from repository changelogs.

Before removing the eight retired Work Item fields, migrate populated values, preserve a verbatim page history copy, deploy both writers and readers, and verify live processing. A completed merge receipt prevents retries from resetting a new development cycle.
