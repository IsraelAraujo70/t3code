import { describe, expect, it } from "vite-plus/test";

import { ERROR_MESSAGES, errorFromFailure, errorFromResponse, GuestApiError } from "./api";
import { imageUpload, LIMITS } from "./images";

describe("errorFromResponse", () => {
  it("sends a 401 back to pairing with the revoked-access text", () => {
    const error = errorFromResponse(401, '{"error":"invalid token"}');
    expect(error.kind).toBe("unauthorized");
    expect(error.message).toBe("Seu acesso expirou ou foi revogado. Peça um novo QR code.");
  });

  it("shows the server's own error text", () => {
    const error = errorFromResponse(400, '{"error":"A mensagem está vazia."}');
    expect(error).toMatchObject({ kind: "rejected", message: "A mensagem está vazia." });
  });

  it("falls back to a friendly text without a usable body", () => {
    expect(errorFromResponse(502, "<html>Bad gateway</html>").message).toBe(ERROR_MESSAGES.server);
    expect(errorFromResponse(404, "").message).toBe("Algo deu errado (código 404).");
    expect(errorFromResponse(413, "").message).toBe(ERROR_MESSAGES.tooLarge);
  });
});

describe("errorFromFailure", () => {
  it("maps fetch failures to Portuguese network messages", () => {
    expect(errorFromFailure(new TypeError("Network request failed"))).toMatchObject({
      kind: "network",
      message: ERROR_MESSAGES.offline,
    });
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    expect(errorFromFailure(abort).message).toBe(ERROR_MESSAGES.timeout);
  });

  it("passes API errors through unchanged", () => {
    const error = new GuestApiError("unauthorized", ERROR_MESSAGES.unauthorized);
    expect(errorFromFailure(error)).toBe(error);
  });
});

describe("imageUpload", () => {
  it("takes the type from the bytes, not the file name", () => {
    const result = imageUpload({ base64: "iVBORw0KGgoAAAA", fileName: "IMG_1.HEIC", index: 0 });
    expect(result).toEqual({
      ok: true,
      upload: {
        name: "IMG_1.HEIC",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAA",
      },
    });
  });

  it("names unnamed photos and rejects unknown or oversized data", () => {
    expect(imageUpload({ base64: "/9j/4AAQ", fileName: null, index: 1 })).toMatchObject({
      ok: true,
      upload: { name: "foto-2.jpg", mimeType: "image/jpeg" },
    });
    expect(imageUpload({ base64: "AAAAIGZ0eXBoZWlj", fileName: null, index: 0 }).ok).toBe(false);
    const huge = `/9j/${"A".repeat(Math.ceil((LIMITS.imageBytes * 4) / 3) + 8)}`;
    expect(imageUpload({ base64: huge, fileName: null, index: 0 }).ok).toBe(false);
  });
});
