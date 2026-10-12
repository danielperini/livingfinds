/** Amazon Ads v3 *Filter fields use objects with an `include` array, never bare arrays. */
export function includeFilter<T>(values: readonly T[]): { include: T[] } {
  return { include: [...values] };
}
