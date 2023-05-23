const fs = require('node:fs');

const punycode = require('punycode/');

const RateLimiter = require('async-ratelimiter');
const _ = require('lodash');
const bytes = require('bytes');
const getStream = require('get-stream');
const isFQDN = require('is-fqdn');
const isSANB = require('is-string-and-not-blank');
const ms = require('ms');
const pify = require('pify');
const safeStringify = require('fast-safe-stringify');
const splitLines = require('split-lines');
const { SMTPServer } = require('smtp-server');
const { isEmail } = require('validator');
const { boolean } = require('boolean');

const Aliases = require('#models/aliases');
const Domains = require('#models/domains');
const Emails = require('#models/emails');
const config = require('#config');
const createSession = require('#helpers/create-session');
const createTangerine = require('#helpers/create-tangerine');
const env = require('#config/env');
const getErrorCode = require('#helpers/get-error-code');
const isCodeBug = require('#helpers/is-code-bug');
const logger = require('#helpers/logger');
const parseRootDomain = require('#helpers/parse-root-domain');

const MAX_BYTES = bytes(env.SMTP_MESSAGE_MAX_SIZE);

class ServerShutdownError extends Error {
  // NOTE: smtp-server does not have an affixed "." in the server shutdown message
  constructor(message = 'Server shutting down', ...args) {
    super(message, ...args);
    Error.captureStackTrace(this, ServerShutdownError);
    this.responseCode = 421;
  }
}

class SMTPError extends Error {
  constructor(message, options = {}, ...args) {
    super(message, options, ...args);
    Error.captureStackTrace(this, SMTPError);
    this.responseCode = options?.responseCode || 550;
    if (options.ignoreHook === true) this.ignoreHook = true;
  }
}

function validateDomain(domain) {
  if (!domain)
    throw new Error(
      'Domain does not exist with current TXT verification record'
    );

  if (domain.is_global) throw new Error('Cannot send email from global domain');

  if (_.isDate(domain.smtp_suspended_sent_at))
    throw new Error('Domain is suspended from outbound SMTP access');

  if (!domain.has_smtp)
    throw new Error('Domain does not have outbound SMTP access');

  //
  // validate that at least one paying, non-banned admin on >= same plan without expiration
  //
  const validPlans =
    domain.plan === 'team' ? ['team'] : ['team', 'enhanced_protection'];

  if (
    !domain.members.some(
      (m) =>
        !m.user[config.userFields.isBanned] &&
        m.user[config.userFields.hasVerifiedEmail] &&
        validPlans.includes(m.user.plan) &&
        new Date(m.user[config.userFields.planExpiresAt]).getTime() >=
          Date.now() &&
        m.group === 'admin'
    )
  )
    throw new Error(
      'Domain has past due balance or does not have at least one valid admin'
    );
}

function validateAlias(alias) {
  // alias must exist
  if (!alias) throw new Error('Alias does not exist');

  // alias must not have banned user
  if (alias.user[config.userFields.isBanned])
    throw new Error('Alias user is banned');

  // alias must be enabled
  if (!alias.is_enabled) throw new Error('Alias is disabled');

  // alias must not be catch-all
  if (alias.name === '*') throw new Error('Alias cannot be a catch-all');

  // alias cannot be regex
  if (alias.name.startsWith('/')) throw new Error('Alias cannot be a regex');
}

// this is sourced from FE original codebase
function refineAndLogError(err, session) {
  // handle programmer mistakes
  // (don't re-check if we already checked)
  if (typeof err.isCodeBug !== 'boolean') {
    err.isCodeBug = isCodeBug(err);
    if (err.isCodeBug) {
      logger.fatal(err, { session });
      // TODO: rewrite `err.response` and `err.message` if either/both start with diagnostic code
      err.responseCode = 421;
    }
  }

  // if it was HTTP error and no `responseCode` set then try to parse it
  // into a SMTP-friendly format for error handling
  // TODO: rewrite `err.response` and `err.message` if either/both start with diagnostic code
  err.responseCode = getErrorCode(err);

  // rewrite message to keep the underlying code issue private to end users
  // (this also prevents double logger invocation for code bugs)
  if (err.isCodeBug) {
    err.message =
      'An internal server error has occurred, please try again later.';
  } else {
    logger.error(err, { session });
  }

  //
  // replace linebreaks
  //
  // (otherwise you will get DATA command failed if this is RCPT TO command if you have multiple linebreaks)
  //
  const lines = splitLines(err.message);

  //
  // NOTE: we join lines together by ";", then split, then make unique, then join again
  //
  // set the new message
  err.message = _.uniq(lines.join('; ').split('; ')).join('; ');

  return err;
}

//
// NOTE: we can merge SMTP/FE codebase in future and simply check if auth disabled
//       then this will act as a forwarding server only (MTA)
//
async function onData(stream, _session, fn) {
  if (this.server._closeTimeout)
    return setImmediate(() => fn(new ServerShutdownError()));

  // store clone of session since it gets modified/destroyed
  const session = JSON.parse(safeStringify(_session));

  logger.debug('DATA', { session });

  try {
    // we have to consume the stream
    const raw = await getStream.buffer(stream, {
      maxBuffer: MAX_BYTES
    });

    //
    // NOTE: we don't share the full alias and domain object
    //       in between onAuth and onData because there could
    //       be a time gap between the SMTP commands are sent
    //       (we want the most real-time information)
    //
    // ensure that user is authenticated
    if (
      typeof session.user !== 'object' ||
      typeof session.user.alias_id !== 'string' ||
      typeof session.user.domain_id !== 'string'
    )
      // match smtp-server approach to authentication required
      // <https://github.com/nodemailer/smtp-server/blob/96c0bee3d4802ccc5a1281f46fac707bcfa1eea6/lib/smtp-connection.js#L493>
      throw new SMTPError('Error: authentication Required', {
        responseCode: 530
      });

    // shorthand variables for alias and domain
    const [alias, domain] = await Promise.all([
      Aliases.findOne({ id: session.user.alias_id })
        .populate('user', `id ${config.userFields.isBanned}`)
        .lean()
        .exec(),
      Domains.findOne({ id: session.user.domain_id, plan: { $ne: 'free' } })
        .populate(
          'members.user',
          `id plan ${config.userFields.isBanned} ${config.userFields.hasVerifiedEmail} ${config.userFields.planExpiresAt}`
        )
        .lean()
        .exec()
    ]);

    // validate domain
    validateDomain(domain);

    // validate alias
    validateAlias(alias);

    // TODO: document storage of outbound SMTP email in FAQ/Privacy
    //       (it will be retained for 30d after + enable 30d expiry)
    // TODO: document suspension process in Terms of Use
    //       (e.g. after 30d unpaid access, API access restrictions, etc)
    // TODO: suspend domains with has_smtp that have past due balance

    // prepare envelope
    const envelope = {};

    if (
      isEmail(session?.envelope?.mailFrom?.address, { ignore_max_length: true })
    )
      envelope.from = session.envelope.mailFrom.address;

    if (
      Array.isArray(session?.envelope?.rcptTo) &&
      session.envelope.rcptTo.length > 0
    ) {
      const to = [];
      for (const rcpt of session.envelope.rcptTo) {
        if (isEmail(rcpt.address, { ignore_max_length: true })) to.push(rcpt);
      }

      if (to.length > 0) envelope.to = to;
    }

    // queue the email
    const email = await Emails.queue({
      message: {
        envelope,
        raw
      },
      alias,
      domain,
      user: alias.user,
      date: new Date(session.arrivalDate)
    });

    logger.info('email created', {
      session: createSession(email),
      user: email.user,
      email: email._id,
      domains: [email.domain],
      ignore_hook: false
    });

    // send long running bree worker a signal to queue the email
    // otherwise if it's not running then attempt to start it up
    if (this?.bree?.workers?.get('send-emails')) {
      try {
        this.bree.workers.get('send-emails').postMessage({ id: email.id });
      } catch (err) {
        // TODO: email admins once every hour if this is the case
        logger.error(err);
      }
    } else if (this?.bree) {
      // TODO: email admins once every hour if this is the case
      logger.error(new Error('send-emails is not running'));
    }

    setImmediate(fn);
  } catch (err) {
    setImmediate(() => fn(refineAndLogError(err, session)));
  }
}

async function onConnect(session, fn) {
  logger.debug('CONNECT', { session });

  if (this.server._closeTimeout)
    return setImmediate(() => fn(new ServerShutdownError()));

  // this is used for setting Date header if missing on SMTP submission
  session.arrivalDate = new Date();

  // lookup the client hostname
  try {
    const [clientHostname] = await this.resolver.reverse(session.remoteAddress);
    if (isFQDN(clientHostname)) {
      // do we need this still (?)
      let domain = clientHostname.toLowerCase().trim();
      try {
        domain = punycode.toASCII(domain);
      } catch {
        // ignore punycode conversion errors
      }

      session.resolvedClientHostname = domain;
    }
  } catch (err) {
    //
    // NOTE: the native Node.js DNS module would throw an error previously
    //       <https://github.com/nodejs/node/issues/3112#issuecomment-1452548779>
    //
    if (env.NODE_ENV !== 'test') logger.debug(err);
  }

  try {
    // get root domain if available
    let rootDomain;
    if (session.resolvedClientHostname)
      rootDomain = parseRootDomain(session.resolvedClientHostname);

    //
    // prevent connections from backscatter, silent ban, and denylist
    //
    const arr = [
      `backscatter:${session.remoteAddress}`,
      `denylist:${session.remoteAddress}`,
      `silent:${session.remoteAddress}`
    ];

    if (rootDomain)
      arr.push(
        `backscatter:${rootDomain}`,
        `denylist:${rootDomain}`,
        `silent:${rootDomain}`
      );

    const results = await this.client.mget(arr);
    if (results.some((result) => boolean(result)))
      throw new SMTPError('Try again later', { ignoreHook: true });

    // rate limit to 100 connections per hour then denylist
    const limit = await this.rateLimiter.get({
      id: rootDomain || session.remoteAddress
    });

    if (!limit.remaining) {
      // add to denylist if rate limit exceeded
      const pipeline = this.client.pipeline();
      if (rootDomain) pipeline.set(`denylist:${rootDomain}`, 'true');
      pipeline.set(`denylist:${session.remoteAddress}`, 'true');
      pipeline
        .exec()
        .then()
        .catch((err) => logger.fatal(err));

      // return 550 error code
      throw new SMTPError('Try again later', { ignoreHook: true });
    }

    setImmediate(fn);
  } catch (err) {
    setImmediate(() => fn(refineAndLogError(err, session)));
  }
}

async function onAuth(auth, session, fn) {
  logger.debug('AUTH', { auth, session });

  if (this.server._closeTimeout)
    return setImmediate(() => fn(new ServerShutdownError()));

  // TODO: credit system + domain billing rules (assigned billing manager -> person who gets credits deducted)
  // TODO: salt/hash/deprecate legacy API token + remove from API docs page
  // TODO: replace usage of config.recordPrefix with config.paidPrefix and config.freePrefix

  //
  // TODO: add support for domain-wide tokens (right now it's only alias-specific)
  // `auth.username` must be an alias that exists in the system
  // `auth.password` must be domain-wide or alias-specific generated token
  // (password visible only once to user upon creation)
  //
  try {
    // username must be a valid email address
    if (!isSANB(auth?.username) || !isEmail(auth?.username))
      throw new Error('Invalid username');

    // password must be a string not longer than 128 characters
    if (
      !isSANB(auth?.password) ||
      (typeof auth?.password === 'string' && auth.password.length > 128)
    )
      throw new Error('Invalid password');

    const [name, domainName] = auth.username.trim().toLowerCase().split('@');
    const verifications = [];
    const records = await this.resolver.resolveTxt(domainName);
    for (const record_ of records) {
      const record = record_.join('').trim(); // join chunks together
      if (record.startsWith(config.paidPrefix))
        verifications.push(record.replace(config.paidPrefix, '').trim());
    }

    if (verifications.length === 0)
      throw new Error('Domain is missing TXT verification record');

    if (verifications.length > 1)
      throw new Error('Domain has more than one TXT verification record');

    const domain = await Domains.findOne({
      name: domainName,
      verification_record: verifications[0],
      plan: { $ne: 'free' }
    })
      .populate(
        'members.user',
        `id plan ${config.userFields.isBanned} ${config.userFields.hasVerifiedEmail} ${config.userFields.planExpiresAt}`
      )
      .lean()
      .exec();

    // validate domain
    validateDomain(domain);

    const alias = await Aliases.findOne({
      name,
      domain: domain._id
    })
      .populate('user', `id ${config.userFields.isBanned}`)
      .lean()
      .exec();

    // validate alias
    validateAlias(alias);

    // validate the `auth.password` provided
    if (!Array.isArray(alias.tokens) || alias.tokens.length === 0)
      throw new Error('Alias does not have any SMTP generated passwords yet');

    // ensure that the token is valid
    if (!Aliases.isValidPassword(alias.tokens, auth.password))
      throw new Error('Invalid password');

    // this response object sets `session.user` to have `domain` and `alias`
    // <https://github.com/nodemailer/smtp-server/blob/a570d0164e4b4ef463eeedd80cadb37d5280e9da/lib/sasl.js#L235>
    setImmediate(() =>
      fn(null, { user: { alias_id: alias.id, domain_id: domain.id } })
    );
  } catch (err) {
    logger.err(err, { session });
    //
    // TODO: we should actually share error message if it was not a code bug
    //       (otherwise it won't be intuitive to users if they're late on payment)
    //
    // <https://github.com/nodemailer/smtp-server/blob/a570d0164e4b4ef463eeedd80cadb37d5280e9da/lib/sasl.js#L189-L222>
    setImmediate(() =>
      fn(
        refineAndLogError(
          new SMTPError('Invalid username or password', {
            responseCode: 535,
            ignoreHook: true
          }),
          session
        )
      )
    );
  }
}

function onMailFrom(address, session, fn) {
  logger.debug('MAIL FROM', { address, session });

  if (this.server._closeTimeout)
    return setImmediate(() => fn(new ServerShutdownError()));

  // validate email address
  if (
    typeof address === 'object' &&
    isSANB(address.address) &&
    !isEmail(address.address, { ignore_max_length: true })
  )
    return setImmediate(() =>
      fn(
        refineAndLogError(
          new SMTPError('Address is not a valid RFC 5321 email address', {
            responseCode: 553,
            ignoreHook: true
          }),
          session
        )
      )
    );

  setImmediate(fn);
}

function onRcptTo(address, session, fn) {
  logger.debug('RCPT TO', { address, session });

  if (this.server._closeTimeout)
    return setImmediate(() => fn(new ServerShutdownError()));

  // <https://github.com/nodemailer/smtp-server/issues/179>
  if (
    session.envelope.rcptTo &&
    session.envelope.rcptTo.length >= config.maxRecipients
  )
    return setImmediate(() =>
      fn(
        refineAndLogError(
          new SMTPError('Too many recipients', {
            responseCode: 452,
            ignoreHook: true
          })
        ),
        session
      )
    );

  // validate email address
  if (
    typeof address === 'object' &&
    isSANB(address.address) &&
    !isEmail(address.address, { ignore_max_length: true })
  )
    return setImmediate(() =>
      fn(
        refineAndLogError(
          new SMTPError('Address is not a valid RFC 5321 email address', {
            responseCode: 553,
            ignoreHook: true
          })
        ),
        session
      )
    );

  setImmediate(fn);
}

class SMTP {
  //
  // NOTE: we port forward 25, 587, and 2525 -> 2587 (and 2587 is itself available)
  // NOTE: we port forward 465 -> 2465 (and 2465 is itself available)
  // NOTE: on IPv6 we cannot port forward 25, 587, 2525, and 465 since ufw not support REDIRECT for ipv6
  //       therefore we use socat in a systemd service that's always running
  //       (this is still a more lightweight approach than having multiple processes running to cover all the ports)
  //
  constructor(options = {}, secure = env.SMTP_PORT === 2465) {
    this.client = options.client;
    this.resolver = createTangerine(this.client, logger);
    this.bree = options.bree;

    //
    // NOTE: hard-coded values for now (switch to env later)
    //       (current limit is 10 failed login attempts per hour)
    //
    this.rateLimiter = new RateLimiter({
      db: this.client,
      max: 100,
      duration: ms('1h'),
      namespace: `smtp_auth_limit_${config.env}`
    });

    // setup our smtp server which listens for incoming email
    // TODO: <https://github.com/nodemailer/smtp-server/issues/177>
    this.server = new SMTPServer({
      //
      // most of these options mirror the FE forwarding server options
      //
      size: MAX_BYTES,
      onData: onData.bind(this),
      onConnect: onConnect.bind(this),
      onAuth: onAuth.bind(this),
      onMailFrom: onMailFrom.bind(this),
      onRcptTo: onRcptTo.bind(this),
      // NOTE: we don't need to set a value for maxClients
      //       since we have rate limiting enabled by IP
      // maxClients: Infinity, // default is Infinity
      // allow 3m to process bulk RCPT TO
      socketTimeout: ms('180s'),
      // default closeTimeout is 30s
      closeTimeout: ms('30s'),
      logInfo: true,
      // <https://github.com/nodemailer/smtp-server/issues/177>
      disableReverseLookup: true,
      logger,

      disabledCommands: secure ? ['STARTTLS'] : [],
      secure,
      needsUpgrade: secure,
      authMethods: ['PLAIN', 'LOGIN'], // XOAUTH2, CRAM-MD5

      // just in case smtp-server changes default and patch semver bump (unlikely but safeguard)
      allowInsecureAuth: false,
      authOptional: false,

      // keys
      ...(config.env === 'production'
        ? {
            key: fs.readFileSync(env.WEB_SSL_KEY_PATH),
            cert: fs.readFileSync(env.WEB_SSL_CERT_PATH),
            ca: fs.readFileSync(env.WEB_SSL_CA_PATH)
          }
        : {})
    });

    // kind of hacky but I filed a GH issue
    // <https://github.com/nodemailer/smtp-server/issues/135>
    this.server.address = this.server.server.address.bind(this.server.server);

    this.server.on('error', (err) => {
      logger.warn(err);
    });

    this.listen = this.listen.bind(this);
    this.close = this.close.bind(this);
  }

  //
  // TODO: rewrite below to remove `pify` usage
  //

  async listen(port = env.SMTP_PORT, host = '::', ...args) {
    await pify(this.server.listen).bind(this.server)(port, host, ...args);
  }

  async close() {
    await pify(this.server.close).bind(this.server);
  }
}

module.exports = SMTP;