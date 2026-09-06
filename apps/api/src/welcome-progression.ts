import type { WelcomeGrantResult, WelcomeGrantService } from '@seed/credits';

type WelcomeProgressionService = Pick<
  WelcomeGrantService,
  'grantL0' | 'grantDaily' | 'grantL1' | 'grantL2'
>;

/** Run each welcome tier independently: a transient grant failure must not lose a daily visit. */
export async function runWelcomeProgression(input: {
  welcome: WelcomeProgressionService;
  userId: string;
  clusterKey: string;
  sourceIp: string;
  email: string | null;
  captchaToken: string | undefined;
  phoneHash: string | null;
  record: (result: WelcomeGrantResult) => void;
  onError: (level: string, err: unknown) => void;
}): Promise<void> {
  const attempt = async (
    level: string,
    grant: () => Promise<WelcomeGrantResult>,
  ): Promise<void> => {
    try {
      input.record(await grant());
    } catch (err) {
      input.onError(level, err);
    }
  };

  await attempt('L0', () =>
    input.welcome.grantL0({
      userId: input.userId,
      clusterKey: input.clusterKey,
      sourceIp: input.sourceIp,
      email: input.email,
      captchaToken: input.captchaToken,
    }),
  );
  await attempt('daily', () => input.welcome.grantDaily({ userId: input.userId }));
  await attempt('L1', () =>
    input.welcome.grantL1({ userId: input.userId, clusterKey: input.clusterKey }),
  );
  const phoneHash = input.phoneHash;
  if (phoneHash) {
    await attempt('L2', () =>
      input.welcome.grantL2({
        userId: input.userId,
        phoneHash,
        clusterKey: input.clusterKey,
      }),
    );
  }
}
