import type { GUEST_LIMITS, GuestImageUpload } from "@t3tools/contracts";

export const LIMITS = {
  text: 20_000,
  attachments: 4,
  imageBytes: 8 * 1024 * 1024,
  historyDefault: 50,
  historyMax: 200,
} as const satisfies typeof GUEST_LIMITS;

const SIGNATURES: ReadonlyArray<readonly [string, GuestImageUpload["mimeType"], string]> = [
  ["/9j/", "image/jpeg", "jpg"],
  ["iVBORw0KGgo", "image/png", "png"],
  ["R0lGOD", "image/gif", "gif"],
  ["UklGR", "image/webp", "webp"],
];

/**
 * Builds the upload for a picked photo from its base64 bytes. The type comes from the bytes'
 * signature, because the picker's `mimeType` describes the original file, not the re-encoded data.
 */
export function imageUpload(input: {
  readonly base64: string;
  readonly fileName: string | null | undefined;
  readonly index: number;
}):
  | { readonly ok: true; readonly upload: GuestImageUpload }
  | { readonly ok: false; readonly error: string } {
  const signature = SIGNATURES.find(([prefix]) => input.base64.startsWith(prefix));
  if (signature === undefined) {
    return { ok: false, error: "Esse tipo de imagem não é aceito. Tente uma foto JPG ou PNG." };
  }
  if (Math.floor((input.base64.length * 3) / 4) > LIMITS.imageBytes) {
    return { ok: false, error: "Essa foto é grande demais para enviar." };
  }
  const [, mimeType, extension] = signature;
  const fileName = input.fileName?.trim().slice(0, 255);
  return {
    ok: true,
    upload: {
      name: fileName || `foto-${input.index + 1}.${extension}`,
      mimeType,
      dataUrl: `data:${mimeType};base64,${input.base64}`,
    },
  };
}
