export function requireAzureGuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  ) {
    throw new Error(`${name} must be a GUID.`);
  }
  return value.trim().toLowerCase();
}
