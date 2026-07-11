# Review Schema Final

## Tables

### `review_items`

| Field | Type | Nullable | Constraints | Source |
|-------|------|----------|-------------|--------|
| id | BigInt (autoincrement) | NO | PK | Generated |
| publicId | String | NO | UNIQUE | `review:item:{id}` suffix |
| title | String | NO | | `item.title` |
| type | String | NO | Default "general" | `item.type` |
| source | String | YES | | `item.source` |
| sourceId | String | YES | | `item.sourceId` |
| status | String | NO | Default "pending" | `item.status` |
| priority | Int | NO | Default 1 | `item.priority` |
| confidence | Decimal(4,3) | YES | | `item.confidence` |
| figureId | BigInt | YES | | `item.figureId` (string or number) |
| figureSlug | String | YES | | `item.figureSlug` |
| riskType | String | YES | | `item.riskType` |
| riskReason | String | YES | | `item.riskReason` |
| suggestedAction | String | YES | | `item.suggestedAction` |
| evidenceFingerprint | String | YES | | `item.evidenceFingerprint` |
| reviewer | String | YES | | `item.reviewer` |
| decisionReason | String | YES | | `item.decisionReason` |
| decisionAt | DateTime | YES | | `item.decisionAt` |
| appliedAt | DateTime | YES | | Computed from events |
| originalRedisKey | String | YES | UNIQUE | Full key `review:item:{id}` |
| redisFormatVersion | Int | NO | Default 1 | Backfill version |
| payload | Json | YES | | `item.candidateImage`, `detailSnapshot`, `automation`, original `payload` |
| notes | String | YES | | `item.notes` (audit trail) |
| version | Int | NO | Default 0 | Optimistic lock |
| createdAt | DateTime | NO | Default now() | `item.createdAt` |
| updatedAt | DateTime | NO | @updatedAt | `item.updatedAt` |

### `review_events`

| Field | Type | Nullable | Constraints | Source |
|-------|------|----------|-------------|--------|
| id | BigInt (autoincrement) | NO | PK | Generated |
| reviewItemId | BigInt | NO | FK → review_items.id CASCADE | `review:item:{id}` |
| event | String | NO | | "create", "action", "recheck", "apply", "update", "suppression" |
| action | String | YES | | `reviewActionSchema` value |
| fromStatus | String | YES | | Previous status |
| toStatus | String | NO | | New status |
| actor | String | YES | | `item.reviewer` or "system" |
| reason | String | YES | | `item.decisionReason` |
| requestId | String | YES | | Idempotency key |
| metadata | Json | YES | | Additional event context |
| createdAt | DateTime | NO | Default now() | Event timestamp |

## Indexes

| Table | Index | Columns | Purpose |
|-------|-------|---------|---------|
| review_items | `publicId` UNIQUE | publicId | Match Redis ID, prevent duplicate backfill |
| review_items | `originalRedisKey` UNIQUE | originalRedisKey | Track backfill origin |
| review_items | `status_created` | status, createdAt | Review list queries |
| review_items | `figure_id` | figureId | Filter by figure |
| review_items | `risk_type` | riskType | Filter by risk |
| review_items | `evidence_fingerprint` | evidenceFingerprint | Dedup check (non-unique allows re-review) |
| review_events | `item_created` | reviewItemId, createdAt | Event timeline per item |
| review_events | `request_id` | requestId | Idempotency lookup |
