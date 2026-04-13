function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateAnnotationId(): string {
  return generateId("ann");
}

export function generateMessageId(): string {
  return generateId("msg");
}

export function generateEventId(): string {
  return generateId("evt");
}

export function generateReplyId(): string {
  return generateId("rpl");
}

export function generateNotificationId(): string {
  return generateId("ntf");
}

export function generateAuthorshipId(author: "user" | "claude"): string {
  return generateId(author);
}
