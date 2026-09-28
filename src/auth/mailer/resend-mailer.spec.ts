import { ResendMailer, type ResendResponse } from './resend-mailer';

const SETTINGS = { apiKey: 're_test_key', from: 'Pebble <hi@pebble.test>' };

describe('ResendMailer', () => {
  let post: jest.Mock<
    Promise<ResendResponse>,
    [string, Record<string, string>, unknown]
  >;
  let mailer: ResendMailer;

  beforeEach(() => {
    post = jest.fn<
      Promise<ResendResponse>,
      [string, Record<string, string>, unknown]
    >();
    mailer = new ResendMailer(SETTINGS, post);
  });

  it('sends the code to the address, from our sender, with our key', async () => {
    post.mockResolvedValue({ status: 200, body: '{"id":"email-id"}' });

    await mailer.sendSignInCode('ada@example.com', '123456');

    const [url, headers, body] = post.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(headers).toEqual({ Authorization: 'Bearer re_test_key' });
    expect(body).toMatchObject({
      from: 'Pebble <hi@pebble.test>',
      to: ['ada@example.com'],
      subject: expect.stringContaining('123456') as unknown,
      text: expect.stringContaining('123456') as unknown,
    });
  });

  it('rejects when Resend refuses the message', async () => {
    post.mockResolvedValue({
      status: 403,
      body: '{"message":"The pebble.test domain is not verified."}',
    });

    await expect(
      mailer.sendSignInCode('ada@example.com', '123456'),
    ).rejects.toThrow('Resend answered 403');
  });

  it('rejects when Resend is unreachable', async () => {
    post.mockRejectedValue(new Error('fetch failed'));

    await expect(
      mailer.sendSignInCode('ada@example.com', '123456'),
    ).rejects.toThrow('fetch failed');
  });
});
