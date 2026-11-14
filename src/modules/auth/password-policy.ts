// Password length bounds, shared by the Better Auth configuration and the Owner bootstrap. The minimum
// follows NIST SP 800-63B-4 for a password used as the only factor (no 2FA exists yet); the maximum is
// Better Auth's default. No composition rules. Plain TypeScript so the bootstrap script can import it.
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 128;
