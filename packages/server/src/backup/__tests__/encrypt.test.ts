import { decryptBackup, encryptBackup } from "../encrypt.js";
import { describe, expect, it } from "vitest";

describe("backup encryption", () => {
  const key = "a-long-test-recovery-key-with-entropy";

  it("round-trips a database dump", () => {
    const dump = Buffer.from("postgres dump bytes\0\xff", "binary");
    expect(decryptBackup(encryptBackup(dump, key), key)).toEqual(dump);
  });

  it("rejects the wrong recovery key", () => {
    const encrypted = encryptBackup(Buffer.from("private"), key);
    expect(() => decryptBackup(encrypted, "another-long-test-recovery-key")).toThrow();
  });

  it("uses a unique salt and IV for every backup", () => {
    const dump = Buffer.from("same dump");
    expect(encryptBackup(dump, key)).not.toEqual(encryptBackup(dump, key));
  });
});
