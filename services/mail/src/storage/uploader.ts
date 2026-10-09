// What the mail service needs from a cloud storage service to save attachments into it.
export interface Uploader {
  // The folder at a path such as "OneBox/Receipts", creating what is missing; "" is the top.
  folderAt(token: string, accountId: string, path: string): Promise<string>;
  upload(
    token: string,
    folder: string,
    file: { name: string; type: string; body: Buffer },
  ): Promise<{ name: string; link: string }>;
  // Drops cached folder ids, e.g. after a folder was deleted.
  forget(accountId: string): void;
}
