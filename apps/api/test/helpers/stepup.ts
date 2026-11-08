export const TEST_PIN = '482916';

/** Enrolls the standard test PIN for the bearer token's user (idempotent for tests: ignores "already enrolled"). */
export async function enrollTestPin(baseUrl: string, token: string, pin = TEST_PIN): Promise<void> {
  const res = await fetch(`${baseUrl}/api/auth/step-up/pin`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, currentPin: pin })
  });
  if (res.status === 200) return;
  // First enrollment has no existing PIN, so `currentPin` is simply ignored by the server.
  const again = await fetch(`${baseUrl}/api/auth/step-up/pin`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  if (again.status !== 200) throw new Error(`enrollTestPin failed: ${again.status}`);
}

/** Request-body fields for /decide and /retry derived from a /challenge response's `data` (PIN factor). */
export function stepUp(
  d: { challengeNonce: string },
  pin = TEST_PIN
): { proof: { method: 'pin'; pin: string }; challengeNonce: string } {
  return { proof: { method: 'pin', pin }, challengeNonce: d.challengeNonce };
}
