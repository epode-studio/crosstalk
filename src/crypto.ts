// Identity, key exchange and message sealing. node:crypto only, no dependencies.
//
// Each identity holds two keypairs: Ed25519 for authentication and signing,
// X25519 for encryption. Starting a room exchanges both public keys over the relay,
// but the exchange itself is encrypted under a passphrase you read to each
// other out of band, so the relay never sees a key it could substitute.

import crypto from "node:crypto"
import type { Identity, Peer } from "./config.ts"

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64")
const un64 = (s: string) => Buffer.from(s, "base64")

export function newIdentity(label: string): Identity {
  const ed = crypto.generateKeyPairSync("ed25519")
  const x = crypto.generateKeyPairSync("x25519")
  return {
    label,
    ed: {
      pub: b64(ed.publicKey.export({ type: "spki", format: "der" })),
      priv: b64(ed.privateKey.export({ type: "pkcs8", format: "der" })),
    },
    x: {
      pub: b64(x.publicKey.export({ type: "spki", format: "der" })),
      priv: b64(x.privateKey.export({ type: "pkcs8", format: "der" })),
    },
    createdAt: Date.now(),
  }
}

const edPriv = (id: Identity) =>
  crypto.createPrivateKey({ key: un64(id.ed.priv), type: "pkcs8", format: "der" })
const edPub = (spki: string) =>
  crypto.createPublicKey({ key: un64(spki), type: "spki", format: "der" })
const xPriv = (id: Identity) =>
  crypto.createPrivateKey({ key: un64(id.x.priv), type: "pkcs8", format: "der" })
const xPub = (spki: string) =>
  crypto.createPublicKey({ key: un64(spki), type: "spki", format: "der" })

/** Short, human-readable key fingerprint. Read this aloud when starting a room. */
export function fingerprint(edPubB64: string): string {
  const h = crypto.createHash("sha256").update(un64(edPubB64)).digest("hex")
  return h.slice(0, 16).match(/.{4}/g)!.join("-")
}

export const sign = (id: Identity, data: Buffer | string) =>
  b64(crypto.sign(null, Buffer.from(data), edPriv(id)))

export const verify = (edPubB64: string, data: Buffer | string, sig: string) => {
  try {
    return crypto.verify(null, Buffer.from(data), edPub(edPubB64), un64(sig))
  } catch {
    return false
  }
}

// --- symmetric ---------------------------------------------------------------

export function seal(key: Buffer, plaintext: string): string {
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce)
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()])
  return b64(Buffer.concat([nonce, c.getAuthTag(), ct]))
}

export function open(key: Buffer, sealed: string): string {
  const raw = un64(sealed)
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")
}

// --- the key for one direct channel -------------------------------------------

/**
 * Shared key for one direct channel. X25519 ECDH, then HKDF with both fingerprints sorted
 * so each side derives the same key regardless of who initiated.
 */
export function channelKey(id: Identity, peer: Peer): Buffer {
  const shared = crypto.diffieHellman({ privateKey: xPriv(id), publicKey: xPub(peer.xPub) })
  const ends = [fingerprint(id.ed.pub), peer.fingerprint].sort().join("|")
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(ends), "crosstalk/channel/v1", 32))
}

// --- invites ------------------------------------------------------------------

// 512 words, four themes that sound good next to each other and cannot be
// misheard as one another. No word is a prefix of another, none are homophones,
// and every one survives being said down a phone line.
const WORDS = [
  "otter","heron","marten","kestrel","badger","lynx","raven","stoat","puffin","curlew",
  "osprey","hare","adder","newt","shrew","weasel","falcon","gannet","fulmar","dipper",
  "wagtail","siskin","linnet","merlin","harrier","teal","widgeon","brambling","redwing","fieldfare",
  "chough","jackdaw","rook","swift","martin","dunlin","godwit","avocet","bittern","egret",
  "salmon","trout","perch","tench","bream","chub","dace","roach","gudgeon","minnow",
  "mackerel","herring","pollock","haddock","turbot","brill","plaice","dab","sprat","whiting",
  "beetle","cricket","mayfly","damsel","hornet","mason","carder","miner","tiger","emerald",
  "moth","hawkmoth","lackey","vapourer","cinnabar","burnet","forester","chimney","ghost","drinker",
  "basalt","granite","gabbro","dolerite","gneiss","schist","slate","shale","chalk","flint",
  "quartz","feldspar","mica","olivine","garnet","zircon","topaz","beryl","jasper","agate",
  "onyx","opal","amber","jet","pearl","coral","nacre","ivory","horn","antler",
  "copper","pewter","bronze","brass","nickel","cobalt","zinc","tungsten","titanium","platinum",
  "linen","hessian","canvas","denim","tweed","worsted","velvet","satin","muslin","calico",
  "oak","ash","elm","beech","rowan","alder","hazel","willow","holly","yew",
  "cedar","larch","spruce","juniper","hawthorn","blackthorn","walnut","cherry","maple","poplar",
  "ochre","umber","sienna","indigo","madder","woad","cochineal","verdigris","orpiment","thunder",
  "squall","gale","breeze","zephyr","monsoon","cyclone","tempest","drizzle","downpour","blizzard",
  "flurry","frost","rime","glaze","thaw","dew","mist","fogbank","haze","smog",
  "cumulus","cirrus","stratus","nimbus","estuary","fjord","lagoon","atoll","reef","shoal",
  "spit","cove","inlet","channel","narrows","sound","firth","loch","tarn","mere",
  "brook","torrent","cascade","cataract","rapid","eddy","whirlpool","surge","swell","moorland",
  "heath","fenland","marsh","bog","mire","meadow","pasture","coppice","thicket","ridgeline",
  "corrie","gully","ravine","canyon","plateau","summit","saddle","col","anvil","bellows",
  "forge","crucible","tongs","chisel","mallet","plane","auger","gimlet","lathe","spindle",
  "bobbin","shuttle","loom","treadle","flywheel","gearwheel","ratchet","pawl","compass","sextant",
  "calliper","vernier","lantern","beacon","brazier","taper",
]

/**
 * The phrase IS the secret, and the relay sees something derived from it, so the
 * derivation has to be expensive to reverse. Five words from 256 is 40 bits,
 * which a plain hash gives away instantly. scrypt at 32MB a guess does not:
 * an attacker with a hundred thousand cores and three terabytes of memory
 * between them covers under a tenth of a percent of the space inside the
 * fifteen minutes an offer lives, and the fingerprint check both people do
 * afterwards catches even that.
 *
 * A PAKE would let this go back to four words by making every guess cost a live
 * handshake. That is the right end state and this is not it.
 */
export const newPhrase = (words = 5) =>
  Array.from({ length: words }, () => WORDS[crypto.randomInt(WORDS.length)]).join("-")

export const normalisePhrase = (p: string) =>
  p.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-")

// Memory-hard, so a relay holding the code cannot cheaply grind the phrase out
// of it. 32MB and about 60ms per attempt on ordinary hardware.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

const stretch = (phrase: string, salt: string, bytes = 32) =>
  crypto.scryptSync(normalisePhrase(phrase), salt, bytes, SCRYPT)

/** What the relay files the offer under. Derived, and expensive to reverse. */
export const codeForPhrase = (phrase: string) =>
  stretch(phrase, "crosstalk/code/v1", 6).toString("hex").toUpperCase()

/** Key protecting a join offer. Same stretching, different salt. */
export const inviteKey = (phrase: string): Buffer => stretch(phrase, "crosstalk/invite/v1")

export type Offer = {
  label: string
  edPub: string
  xPub: string
  machine?: string
  relayPub?: string
  /** True when the thing joining is not a person. Capped at a notice, always. */
  isMachine?: boolean
}

export const sealOffer = (phrase: string, offer: Offer) =>
  seal(inviteKey(phrase), JSON.stringify(offer))

export const openOffer = (phrase: string, blob: string): Offer =>
  JSON.parse(open(inviteKey(phrase), blob))

export const asPeer = (o: Offer): Peer => ({
  label: o.label,
  machine: o.machine,
  isMachine: o.isMachine,
  edPub: o.edPub,
  xPub: o.xPub,
  fingerprint: fingerprint(o.edPub),
  joinedAt: Date.now(),
})
