'use strict';

/**
 * The mail providers of the owner's guided setup (plan §AB.16 and §AB.18, 2026-11-13: "email configuration and
 * all our email providers and setup").
 *
 * One provider is one row of the owner's Setup tab: every field of the provider shares one x-required-for, so the
 * guide shows the provider once with its fields under it. Each field carries x-owner-input with the group
 * 'email' (openvibe-shared 4.250.0), plain words, the page the key is made on, and a test.
 *
 * The keys are secret class: they are written through the write-only route, sealed with the service's KEK and
 * never shown again. The test of a provider is one cheap authenticated read (server/mail-probes.js): it never
 * sends a letter and never spends money, and it answers in one line with no key in it.
 *
 * The keys are named without dots: Network's admin proxy keeps a key to [a-z][a-z0-9_]*, so a dotted key could
 * not be saved or tested from the Setup tab.
 *
 * The sending providers keep their key in the vault; sending through one is the sending adapter's step, so a row
 * says so in plain words instead of promising mail that has not left yet.
 */
const SENDING_NAMESPACE = 'mail.sending';
const RECEIVING_NAMESPACE = 'mail.receiving';
const DNS_NAMESPACE = 'mail.dns';

/** The sending providers, in the order the guide shows them. */
const SENDING_PROVIDERS = [
    {
        id: 'ses',
        name: 'Amazon SES',
        group: 'Sending mail',
        requiredFor: 'Sending mail through Amazon SES',
        unlocks: 'Lets OpenVibe.Mail send your mail through Amazon SES. The key is kept in the vault and the test signs a read to Amazon, so you can see it works; sending itself is the next step.',
        get_it_at: 'https://console.aws.amazon.com/iam/home#/security_credentials',
        get_it_how: 'Open IAM, then Users, then your user, then Security credentials, and create an access key. Copy the access key ID and the secret access key, and put in the region the key belongs to (for example eu-west-1).',
        // Amazon's own SPF include, for the DNS check to name the exact record to add.
        spfInclude: 'amazonses.com',
        keys: [
            { name: 'ses_access_key_id', local: 'accessKeyId', title: 'Amazon SES access key ID', secret: true, required: true, example: 'AKIA…',
                words: 'The name of the AWS access key Mail signs its SES requests with. Together with the secret access key and the region it lets Mail reach Amazon SES; without it SES cannot be used.' },
            { name: 'ses_secret_access_key', local: 'secretAccessKey', title: 'Amazon SES secret access key', secret: true, required: true, example: 'wJalr…',
                words: 'The secret half of the AWS access key, shown only once by Amazon. Mail signs every SES request with it; it is kept in the vault and never shown again.' },
            { name: 'ses_region', local: 'region', title: 'Amazon SES region', secret: false, required: true, example: 'eu-west-1',
                words: 'The Amazon region the SES key belongs to, like eu-west-1. Mail sends its requests to that region, so a wrong region means Amazon refuses the key.' },
        ],
    },
    {
        id: 'postmark',
        name: 'Postmark',
        group: 'Sending mail',
        requiredFor: 'Sending mail through Postmark',
        unlocks: 'Lets OpenVibe.Mail send your mail through Postmark. The token is kept in the vault and the test asks Postmark which senders it knows, so you can see it works; sending itself is the next step.',
        get_it_at: 'https://postmarkapp.com/developer/api/account/server-tokens',
        get_it_how: 'Open the server tokens page, click Add Server Token, give it a name, and copy the token it shows (it starts with a long random string).',
        spfInclude: 'postmarkapp.com',
        keys: [
            { name: 'postmark_server_token', local: 'serverToken', title: 'Postmark server token', secret: true, required: true, example: '…',
                words: 'The token Postmark gives a server, used to send and to read that server\'s senders. Mail keeps it in the vault; without it Postmark cannot be used.' },
        ],
    },
    {
        id: 'resend',
        name: 'Resend',
        group: 'Sending mail',
        requiredFor: 'Sending mail through Resend',
        unlocks: 'Lets OpenVibe.Mail send your mail through Resend. The key is kept in the vault and the test asks Resend for your domains, so you can see it works; sending itself is the next step.',
        get_it_at: 'https://resend.com/api-keys',
        get_it_how: 'Open the API keys page, click Create API key, and copy the key it shows. The key may send mail only, which is all Mail needs.',
        spfInclude: 'sendgrid.net',
        keys: [
            { name: 'resend_api_key', local: 'apiKey', title: 'Resend API key', secret: true, required: true, example: 're_…',
                words: 'The key Resend gives an account. Mail keeps it in the vault and uses it to send and to list your domains; without it Resend cannot be used.' },
        ],
    },
    {
        id: 'mailgun',
        name: 'Mailgun',
        group: 'Sending mail',
        requiredFor: 'Sending mail through Mailgun',
        unlocks: 'Lets OpenVibe.Mail send your mail through Mailgun. The key is kept in the vault and the test asks Mailgun for your domains, so you can see it works; sending itself is the next step.',
        get_it_at: 'https://app.mailgun.com/settings/api-keys',
        get_it_how: 'Open the API keys page of your Mailgun account and copy the private key. Mailgun shows the public key beside it; Mail needs the private one.',
        spfInclude: 'mailgun.org',
        keys: [
            { name: 'mailgun_api_key', local: 'apiKey', title: 'Mailgun API key', secret: true, required: true, example: 'key-…',
                words: 'The private key of your Mailgun account, used to send and to list your sending domains. Mail keeps it in the vault; without it Mailgun cannot be used.' },
        ],
    },
    {
        id: 'sendgrid',
        name: 'SendGrid',
        group: 'Sending mail',
        requiredFor: 'Sending mail through SendGrid',
        unlocks: 'Lets OpenVibe.Mail send your mail through SendGrid. The key is kept in the vault and the test asks SendGrid which permissions the key holds, so you can see it works; sending itself is the next step.',
        get_it_at: 'https://app.sendgrid.com/settings/api_keys',
        get_it_how: 'Open the API keys page, click Create API Key, choose Restricted Access with the Mail Send permission, and copy the key it shows once.',
        spfInclude: 'sendgrid.net',
        keys: [
            { name: 'sendgrid_api_key', local: 'apiKey', title: 'SendGrid API key', secret: true, required: true, example: 'SG.…',
                words: 'The key of your SendGrid account. Mail keeps it in the vault and uses it to send; a key with only the Mail Send permission is enough.' },
        ],
    },
    {
        id: 'brevo',
        name: 'Brevo',
        group: 'Sending mail',
        requiredFor: 'Sending mail through Brevo',
        unlocks: 'Lets OpenVibe.Mail send your mail through Brevo. The key is kept in the vault and the test asks Brevo who the account belongs to, so you can see it works; sending itself is the next step.',
        get_it_at: 'https://app.brevo.com/settings/keys/api',
        get_it_how: 'Open the API keys page, click Generate a new API key, give it a name, and copy the key it shows.',
        spfInclude: 'brevo.com',
        keys: [
            { name: 'brevo_api_key', local: 'apiKey', title: 'Brevo API key', secret: true, required: true, example: 'xkeysib-…',
                words: 'The key of your Brevo account. Mail keeps it in the vault and uses it to send and to check your senders; without it Brevo cannot be used.' },
        ],
    },
    {
        id: 'smtp',
        name: 'SMTP relay',
        group: 'Sending mail',
        requiredFor: 'Sending mail through an SMTP relay',
        unlocks: 'Lets OpenVibe.Mail send your mail through your own mail server or relay. The host, port, user name and password are kept in the vault, and the test signs in and stops there: it never sends a letter.',
        get_it_at: 'https://support.google.com/a/answer/176600',
        get_it_how: 'Open your mail provider\'s outgoing server settings and copy the four values: the server (host), the port, the user name and the password. This page is one example of where they sit; any relay works the same way.',
        keys: [
            { name: 'smtp_host', local: 'host', title: 'SMTP host', secret: false, required: true, example: 'smtp.example.com',
                words: 'The name of the mail server Mail hands a letter to, like smtp.example.com. Without it Mail has nowhere to send; it is not a secret, so it is shown plainly.' },
            { name: 'smtp_port', local: 'port', title: 'SMTP port', secret: false, required: true, example: '587', pattern: '^[0-9]{2,5}$',
                words: 'The door number of that mail server: 587 with a sign-in, 465 with TLS from the start, 25 without. Mail needs the same port your provider gives you.' },
            { name: 'smtp_user', local: 'user', title: 'SMTP user name', secret: false, required: false, example: 'mail@example.com',
                words: 'The name Mail signs in with at that server, usually your mail address. Leave it empty when the relay takes no sign-in.' },
            { name: 'smtp_password', local: 'password', title: 'SMTP password', secret: true, required: false, example: '…',
                words: 'The password Mail signs in with at that server. It is kept in the vault, sealed and never shown again; leave it empty when the relay takes no sign-in.' },
        ],
    },
];

/** The receiving side: Cloudflare Email Routing forwards the mail of a domain to an address you chose. */
const RECEIVING_PROVIDERS = [
    {
        id: 'cloudflare-routing',
        name: 'Cloudflare Email Routing',
        group: 'Receiving mail',
        requiredFor: 'Receiving mail through Cloudflare Email Routing',
        unlocks: 'Lets OpenVibe.Mail read the mail routing you set up in Cloudflare, so you can see which rules forward the mail of your domain and where they send it. The test only reads them.',
        get_it_at: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
        get_it_how: 'Create an API token for your zone with the Email Routing Rules permission, then copy it here. In Cloudflare itself, turn on Email Routing for the domain and say where its mail should go.',
        keys: [
            { name: 'cloudflare_email_routing_token', local: 'apiToken', title: 'Cloudflare API token for email routing', secret: true, required: true, example: 'cf…',
                words: 'A Cloudflare API token with the email routing rules permission for your zone. Mail keeps it in the vault and uses it to read the routing rules; without it the rules cannot be read.' },
            { name: 'cloudflare_email_routing_domain', local: 'domain', title: 'Domain that receives mail', secret: false, required: true, example: 'example.com',
                words: 'The domain whose mail Cloudflare routes for you, as plain text with no address in front. Mail looks the zone up under this name to read its routing rules.' },
        ],
    },
];

const PROVIDERS = [...SENDING_PROVIDERS, ...RECEIVING_PROVIDERS];

/** Every provider with the namespace it belongs to. */
const PROVIDERS_BY_NAMESPACE = {
    [SENDING_NAMESPACE]: SENDING_PROVIDERS,
    [RECEIVING_NAMESPACE]: RECEIVING_PROVIDERS,
};

/** The DNS check of a sending domain: its own row in the guide (plan §AB.18). */
const DNS_PROVIDER = {
    id: 'dns',
    name: 'Mail records of a sending domain',
    group: 'Sending mail',
    requiredFor: 'Sending mail from a domain',
    unlocks: 'Shows you which mail records a sending domain still misses: MX, SPF, DKIM, DMARC and BIMI. It reads them live and names the record to add with the exact value to paste at your DNS host.',
    get_it_at: 'https://dash.cloudflare.com/',
    get_it_how: 'Open DNS at the host that holds the domain (Cloudflare: DNS, then Records) and add the records the test names. Nothing is changed for you; the test only reads.',
    keys: [
        { name: 'dns_check_domain', local: 'domain', title: 'Sending domain to check', secret: false, required: true, example: 'example.com',
            words: 'The domain you send mail from, as plain text with no address in front. Its test reads the live MX, SPF, DKIM, DMARC and BIMI records and tells you which one is missing.' },
    ],
};

/** Every field of every provider: the one list the schemas and the tests are built from. */
const ALL_FIELDS = [
    ...PROVIDERS.flatMap((provider) => provider.keys.map((key) => ({ ...key, provider, namespace: namespaceOf(provider) }))),
    ...DNS_PROVIDER.keys.map((key) => ({ ...key, provider: DNS_PROVIDER, namespace: DNS_NAMESPACE })),
];

/** The namespace a provider belongs to. */
function namespaceOf(provider) {
    if (SENDING_PROVIDERS.includes(provider)) return SENDING_NAMESPACE;
    if (RECEIVING_PROVIDERS.includes(provider)) return RECEIVING_NAMESPACE;
    return DNS_NAMESPACE;
}

/** The provider a field belongs to (null for a field of no provider). */
function providerOfKey(key) {
    return ALL_FIELDS.find((field) => field.name === key) || null;
}

/** The secret-class field names: the credentials and the passwords. */
const SECRET_KEYS = new Set(ALL_FIELDS.filter((field) => field.secret).map((field) => field.name));

/** The fields of one namespace, in the order they are shown. */
function fieldsOf(namespace) {
    if (namespace === DNS_NAMESPACE) return DNS_PROVIDER.keys.map((key) => ({ ...key, provider: DNS_PROVIDER, namespace }));
    return (PROVIDERS_BY_NAMESPACE[namespace] || []).flatMap((provider) => provider.keys.map((key) => ({ ...key, provider, namespace })));
}

module.exports = {
    SENDING_NAMESPACE, RECEIVING_NAMESPACE, DNS_NAMESPACE,
    SENDING_PROVIDERS, RECEIVING_PROVIDERS, PROVIDERS, DNS_PROVIDER,
    PROVIDERS_BY_NAMESPACE, ALL_FIELDS, SECRET_KEYS,
    namespaceOf, providerOfKey, fieldsOf,
};
