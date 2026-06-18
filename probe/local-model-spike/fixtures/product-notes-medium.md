# Product Planning Notes — Mobile App v3

These notes capture the planning discussion for the version 3 release. They were drafted by the product team and shared for comment.

## Goals

The primary goal is to improve onboarding completion, which currently sits at 48%. A secondary goal is to reduce the time-to-first-action for new users. The team agreed that retention is the north-star metric.

## Scope

We will ship three features in version 3: a redesigned signup flow, push notifications, and an offline mode. The offline mode is the largest effort and carries the most risk. Push notifications depend on the new consent screen.

The launch target is April 15, 2026, pending a security review.

## Open Questions

It is unclear whether offline mode can be completed by April 15, 2026. The team should decide by the next planning cycle. Another open question is whether to A/B test the new signup flow before a full rollout.

## Metrics

Onboarding completion is 48% today. We expect the redesigned signup flow to raise it to roughly 60%. Daily active users grew 8% last month. The team will track activation weekly.

## Dependencies

The consent screen must ship before push notifications. The offline mode depends on the new sync engine, which is not yet code-complete. Design assets are due from the design team by April 15, 2026.

## Decisions

We decided to prioritize the signup flow first. We decided to defer the offline mode if the sync engine slips. No decision was made on A/B testing.

## Notes

This planning doc will be revisited after the next cycle. All dates are tentative. This section needs no changes and is left as-is.
