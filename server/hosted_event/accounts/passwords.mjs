import crypto from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 32;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const ALLOWED_SCRYPT_COSTS = new Set([16384, 32768, 65536]);
const ALLOWED_SCRYPT_BLOCK_SIZES = new Set([8, 16]);
const ALLOWED_SCRYPT_PARALLELIZATION = new Set([1, 2]);

/** Lazily computed so importing the module never pays a scrypt cost. */
let dummyHashPromise;

/**
 * Verifies the password against a throwaway hash so unknown accounts and
 * wrong passwords cost the same before any response is produced.
 *
 * @param {string} password
 * @returns {Promise<boolean>}
 */
function verifyDummyPassword(password) {
  dummyHashPromise ||= hashPassword(crypto.randomBytes(32).toString("base64"));
  return verifyPassword(password, dummyHashPromise);
}

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
  const derivedKey = await promisifiedScrypt(
    password,
    salt,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
  );
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64"),
    derivedKey.toString("base64"),
  ].join("$");
}

/**
 * @param {string} password
 * @param {string | undefined} storedHash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, storedHash) {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return false;
  const derivedKey = await promisifiedScrypt(
    password,
    parsed.salt,
    parsed.cost,
    parsed.blockSize,
    parsed.parallelization,
  );
  return timingSafeEqual(derivedKey, parsed.derivedKey);
}

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} cost
 * @param {number} blockSize
 * @param {number} parallelization
 * @returns {Promise<Buffer>}
 */
function promisifiedScrypt(password, salt, cost, blockSize, parallelization) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: cost, r: blockSize, p: parallelization },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * @param {string | undefined} storedHash
 * @returns {{salt: Buffer, derivedKey: Buffer, cost: number, blockSize: number, parallelization: number} | null}
 */
function parseStoredHash(storedHash) {
  if (typeof storedHash !== "string") return null;
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, rawCost, rawBlockSize, rawParallelization, rawSalt, rawDerivedKey] =
    parts;
  const cost = Number.parseInt(rawCost || "", 10);
  const blockSize = Number.parseInt(rawBlockSize || "", 10);
  const parallelization = Number.parseInt(rawParallelization || "", 10);
  // Stored hashes are server-written; strict bounds keep tampered values from
  // turning verification into a denial-of-service primitive.
  if (!ALLOWED_SCRYPT_COSTS.has(cost)) return null;
  if (!ALLOWED_SCRYPT_BLOCK_SIZES.has(blockSize)) return null;
  if (!ALLOWED_SCRYPT_PARALLELIZATION.has(parallelization)) return null;
  try {
    const salt = Buffer.from(rawSalt || "", "base64");
    const derivedKey = Buffer.from(rawDerivedKey || "", "base64");
    if (salt.length !== SCRYPT_SALT_LENGTH) return null;
    if (derivedKey.length !== SCRYPT_KEY_LENGTH) return null;
    return { salt, derivedKey, cost, blockSize, parallelization };
  } catch {
    return null;
  }
}

/**
 * @param {Buffer} left
 * @param {Buffer} right
 * @returns {boolean}
 */
function timingSafeEqual(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export { hashPassword, verifyDummyPassword, verifyPassword };
