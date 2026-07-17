import crypto from "crypto";

// Generate a random password with mixed classes (ambiguous chars omitted).
export function generatePassword(length = 18) {
  const sets = {
    upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
    lower: "abcdefghijkmnpqrstuvwxyz",
    digit: "23456789",
    symbol: "!@#$%^&*-_=+",
  };
  const all = Object.values(sets).join("");
  const pick = (set) => set[crypto.randomInt(set.length)];

  // Guarantee at least one of each class, then fill the rest.
  const chars = [pick(sets.upper), pick(sets.lower), pick(sets.digit), pick(sets.symbol)];
  while (chars.length < length) chars.push(pick(all));

  // Fisher–Yates shuffle so the guaranteed chars aren't in fixed positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
