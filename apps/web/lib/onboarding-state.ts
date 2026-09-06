/** POST once more after any non-2xx or network failure; the endpoint is idempotent. */
export async function postOnboarding(
  apiUrl: string,
  answers: Record<string, unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(apiUrl + '/v1/me/onboarded', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      if (response.ok) return true;
    } catch {
      // The second attempt handles a transient network failure.
    }
  }
  return false;
}
