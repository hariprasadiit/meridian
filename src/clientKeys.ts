/** Native inference credentials. Only hashes are persisted; the admin key stays in the environment. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { configPath } from "./configDir"

export interface ClientKeyInfo {
  id: string
  name: string
  createdAt: string
  revokedAt: string | null
}
interface StoredKey extends ClientKeyInfo { hash: string }
interface Registry { version: 1; keys: StoredKey[] }
const MAX_KEYS = 1000
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex")
const validName = (name: unknown): name is string => typeof name === "string"
  && name === name.trim() && name.length > 0 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name)
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const validDate = (value: unknown): value is string => typeof value === "string" && new Date(value).toISOString() === value
const registryPath = () => configPath("client-keys.json")

export class ClientKeyError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message) }
}

export function clientKeysConfigured(): boolean {
  return Boolean(process.env.MERIDIAN_CLIENT_KEY_HASHES) || existsSync(registryPath())
}

function save(registry: Registry) {
  const path = registryPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, JSON.stringify(registry) + "\n")
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(temporary, path)
    const directory = openSync(dirname(path), "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/** Read on each operation: revocations also take effect in another process using the same volume. */
function load(): Registry {
  const path = registryPath()
  if (!existsSync(path)) {
    const seed = JSON.parse(process.env.MERIDIAN_CLIENT_KEY_HASHES || "{}") as unknown
    if (!seed || typeof seed !== "object" || Array.isArray(seed)) throw new Error("Invalid client key seed")
    const entries = Object.entries(seed)
    if (entries.length > MAX_KEYS || entries.some(([name, hash]) => !validName(name) || !validHash(hash))) {
      throw new Error("Invalid client key seed")
    }
    const registry: Registry = { version: 1, keys: entries.map(([name, hash]) => ({
      id: randomUUID(), name, hash: hash as string, createdAt: new Date().toISOString(), revokedAt: null,
    })) }
    // Once the file exists it is authoritative. An old environment seed must never resurrect a revoked key.
    save(registry)
    return registry
  }
  const fd = openSync(path, "r")
  let registry: Registry
  try {
    const bytes = readFileSync(fd)
    if (bytes.length > 512 * 1024) throw new Error("Client key registry exceeds its bound")
    registry = JSON.parse(bytes.toString("utf8"))
  } finally { closeSync(fd) }
  if (registry?.version !== 1 || !Array.isArray(registry.keys) || registry.keys.length > MAX_KEYS
    || registry.keys.some(key => !key || typeof key.id !== "string" || !/^[a-f0-9-]{36}$/.test(key.id)
      || !validName(key.name) || !validHash(key.hash) || !validDate(key.createdAt)
      || (key.revokedAt !== null && !validDate(key.revokedAt)))
    || new Set(registry.keys.map(key => key.id)).size !== registry.keys.length) {
    throw new Error("Invalid client key registry")
  }
  return registry
}

const publicInfo = ({ id, name, createdAt, revokedAt }: StoredKey): ClientKeyInfo => ({ id, name, createdAt, revokedAt })
export function listClientKeys(): ClientKeyInfo[] { return load().keys.map(publicInfo) }

/** Synchronous read/mutate/rename keeps writes serialized in the single Meridian server process. */
export function createClientKey(name: unknown): { key: string; credential: ClientKeyInfo } {
  if (!validName(name)) throw new ClientKeyError("Use a name of 1–64 characters without control characters")
  const registry = load()
  if (registry.keys.length >= MAX_KEYS) throw new ClientKeyError("The key registry is full", 409)
  if (registry.keys.some(key => key.name === name && key.revokedAt === null)) throw new ClientKeyError("An active key already has this name", 409)
  const key = `mrn_${randomBytes(32).toString("hex")}`
  const stored: StoredKey = { id: randomUUID(), name, hash: hashKey(key), createdAt: new Date().toISOString(), revokedAt: null }
  registry.keys.push(stored)
  save(registry)
  return { key, credential: publicInfo(stored) }
}

export function revokeClientKey(id: string): ClientKeyInfo {
  const registry = load()
  const key = registry.keys.find(key => key.id === id)
  if (!key) throw new ClientKeyError("Key not found", 404)
  if (key.revokedAt === null) { key.revokedAt = new Date().toISOString(); save(registry) }
  return publicInfo(key)
}

export function hasValidClientKey(provided: string): boolean {
  const candidate = Buffer.from(hashKey(provided), "hex")
  let matched = false
  for (const key of load().keys) {
    const equal = timingSafeEqual(candidate, Buffer.from(key.hash, "hex"))
    matched = (equal && key.revokedAt === null) || matched
  }
  return matched
}
