/** Keep a valid empty catalogue distinct from a refresh where every request failed. */
export function throwIfAllRejected(results) {
  if (results.length && results.every(result => result.status === 'rejected')) throw results[0].reason;
  return results;
}

export async function settleRequests(tasks) {
  return throwIfAllRejected(await Promise.allSettled(tasks));
}
