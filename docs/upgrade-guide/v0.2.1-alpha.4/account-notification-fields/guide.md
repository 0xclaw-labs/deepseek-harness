---
kind: upgrade-guide
description: "AccountBonusNotification removes unused bonus fields and permits notices without an expiry."
---

# Update account notification consumers

English | [中文](guide.zh.md)

## Change

The public `AccountBonusNotification` returned by `DeepSeekAccount.getUnnotifiedBonuses()` and `account/getUnnotifiedBonuses` no longer includes `campaign`, `amount`, `currency`, or `grantedAt`. Notifications retain `orderId`, `message`, and `expiresAt`, and add an optional `title`. An empty `expiresAt` means the notification never expires. `orderId` accepts arbitrary strings rather than requiring UUIDs.

## Migration

1. Remove reads of the deleted fields from account notification consumers. Display `message` and use the client's default title when `title` is absent.
2. Treat an empty `expiresAt` as no expiry before parsing timestamps. Keep `orderId` unchanged when acknowledging a notification.
3. Update provider fixtures to use the current fields. Confirm that a notification with a non-UUID ID and empty expiry displays and can be acknowledged.
