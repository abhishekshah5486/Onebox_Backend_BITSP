import { GenericContainer, Wait } from 'testcontainers';

export interface MailUser {
  email: string;
  password: string;
}

export interface TestMailServer {
  host: string;
  imapPort: number;
  smtpPort: number;
  stop: () => Promise<void>;
}

// Real IMAP/SMTP server with authentication enabled; users log in with their email address.
export async function startGreenMail(users: MailUser[]): Promise<TestMailServer> {
  const userList = users
    .map(({ email, password }) => {
      const [local, domain] = email.split('@');
      return `${local}:${password}@${domain}`;
    })
    .join(',');

  const container = await new GenericContainer('greenmail/standalone:2.1.14')
    .withEnvironment({
      GREENMAIL_OPTS: [
        '-Dgreenmail.setup.test.imap',
        '-Dgreenmail.setup.test.smtp',
        '-Dgreenmail.hostname=0.0.0.0',
        '-Dgreenmail.users.login=email',
        `-Dgreenmail.users=${userList}`,
      ].join(' '),
    })
    .withExposedPorts(3143, 3025)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  return {
    host: container.getHost(),
    imapPort: container.getMappedPort(3143),
    smtpPort: container.getMappedPort(3025),
    stop: async () => {
      await container.stop();
    },
  };
}
