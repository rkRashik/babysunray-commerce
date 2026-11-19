// Validation of the Owner's account details, shared by the browser setup (setup.ts) and the CLI commands. Pure functions with
// no file or environment access, so the application never bundles the CLI code. Never echoes a value.
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy.ts";

export type OwnerInput = { email: string; name: string; password: string };

// Control characters (including terminal escape sequences from arrow keys) are never meant as input here;
// in a password typed without echo they would be a silent typo.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Trimmed and lowercased, as Better Auth stores it. Never echoes the value. */
export function normalizeEmail(raw: string): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("The email address is not valid.");
  return email;
}

/** The project password policy (password-policy.ts). Never echoes the value. */
export function validatePassword(password: string): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`The password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (CONTROL.test(password)) throw new Error("The password must not contain control characters or arrow-key input.");
  return password;
}

/** Trims and lowercases the email and trims the name; checks the password length. Never echoes a value. */
export function validateOwnerInput(input: OwnerInput): OwnerInput {
  const email = normalizeEmail(input.email);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 100 || CONTROL.test(name)) {
    throw new Error("The name must be 1 to 100 characters, without control characters.");
  }
  return { email, name, password: validatePassword(input.password) };
}

