import type { BBContact } from "./bluebubbles.ts";

/**
 * Normalizes a phone number or email so that "+1 (555) 123-4567", "5551234567"
 * and "+15551234567" all match. Phone numbers are reduced to their last 10 digits,
 * which is good enough for matching within one person's address book.
 */
export function normalizeAddress(address: string): string {
    const trimmed = address.trim().toLowerCase();
    if (trimmed.includes("@")) return trimmed;
    const digits = trimmed.replace(/\D/g, "");
    return digits.length > 10 ? digits.slice(-10) : digits;
}

/** SMS short codes (banks, 2FA, delivery notices) are 5-6 digit senders. */
export function isShortCode(address: string): boolean {
    return /^\d{3,6}$/.test(address.trim());
}

export class ContactBook {
    private readonly names = new Map<string, string>();

    constructor(contacts: BBContact[] = []) {
        for (const c of contacts) {
            const name = c.displayName || [c.firstName, c.lastName].filter(Boolean).join(" ");
            if (!name) continue;
            for (const a of [...(c.phoneNumbers ?? []), ...(c.emails ?? [])]) {
                if (a?.address) this.names.set(normalizeAddress(a.address), name);
            }
        }
    }

    nameFor(address: string): string | null {
        return this.names.get(normalizeAddress(address)) ?? null;
    }

    isKnown(address: string): boolean {
        return this.names.has(normalizeAddress(address));
    }

    label(address: string): string {
        return this.nameFor(address) ?? address;
    }
}
