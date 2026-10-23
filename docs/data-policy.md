# Data and Retention Policy (Implementation Baseline)

## Conversation messages

Messages are stored persistently in the current chat-history persistence layer. Normal chat requests use only the latest five valid stored user/assistant text messages as context. This context limit does not imply that older records are automatically deleted.

## Explicit facts and summaries

The small memory compatibility facade retains user-requested explicit fact add/read/delete operations. Fact lookup is not automatically appended to every prompt. Explicit summary commands and unrelated summary features are retained. Autonomous weekly memory summary work is disabled. Legacy vector/embedding collections may still exist in the database; this release intentionally does not destructively delete them. Plan a separately reviewed archive/deletion migration once the replacement memory design and retention requirements are agreed.

## User/server settings

Default changes apply to new or unset settings unless the migration request explicitly opts into overwriting existing values and provides the exact overwrite confirmation phrase. Explicit false values (such as hiding action buttons) count as chosen values and must be preserved.

## Console audit logs

Console change actions and sensitive reads create audit records without storing request bodies, prompts or OAuth tokens. Production deployments should define an explicit retention and deletion schedule for audit records before launch.

## Open retention work

The existing application does not yet provide a unified retention policy for all chat histories, reminders, usage counters, attachment temporary files, explicit facts, legacy vector records and console audit logs. Do not assume unconfigured records have automatic TTL deletion. Define per-data-class retention, export, deletion and backup expiry in a follow-up policy.
