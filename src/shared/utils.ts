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
