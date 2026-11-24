// What the mail service needs from a cloud storage service to save attachments into it.
export interface Uploader {
  // The folder at a path such as "OneBox/Receipts", creating what is missing; "" is the top.
  folderAt(token: string, accountId: string, path: string): Promise<string>;
  upload(
    token: string,
    folder: string,
    file: { name: string; type: string; body: Buffer },
  ): Promise<{ id: string; name: string; link: string }>;
  // A link anyone can open (to put in an email), for a file uploaded here.
  share(token: string, file: { id: string; link: string }): Promise<string>;
  // Drops cached folder ids, e.g. after a folder was deleted.
  forget(accountId: string): void;
}
