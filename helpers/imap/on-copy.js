/*
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file incorporates work covered by the following copyright and
 * permission notice:
 *
 *   WildDuck Mail Agent is licensed under the European Union Public License 1.2 or later.
 *   https://github.com/nodemailer/wildduck
 */

const mongoose = require('mongoose');
const ms = require('ms');
const tools = require('wildduck/lib/tools');
const { Builder } = require('json-sql');
// const { boolean } = require('boolean');

const Aliases = require('#models/aliases');
const IMAPError = require('#helpers/imap-error');
const Mailboxes = require('#models/mailboxes');
const getAttachments = require('#helpers/get-attachments');
const i18n = require('#helpers/i18n');
const refineAndLogError = require('#helpers/refine-and-log-error');
const updateStorageUsed = require('#helpers/update-storage-used');
const { acquireLock, releaseLock } = require('#helpers/lock');

const builder = new Builder();

// eslint-disable-next-line max-params
async function onCopy(connection, mailboxId, update, session, fn) {
  this.logger.debug('COPY', { connection, mailboxId, update, session });

  if (this.wsp) {
    // start notifying connection of progress
    let timeout;
    try {
      (function update() {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          connection.send('* OK Copy still in progress...');
          update();
        }, ms('15s'));
      })();

      console.time(`copy timer ${session.id}`);
      const [bool, response] = await this.wsp.request({
        action: 'copy',
        session: {
          id: session.id,
          user: session.user,
          remoteAddress: session.remoteAddress
        },
        // connection: null,
        mailboxId,
        update
      });
      console.timeEnd(`copy timer ${session.id}`);
      clearTimeout(timeout);
      fn(null, bool, response);
    } catch (err) {
      clearTimeout(timeout);
      if (err.imapResponse) return fn(null, err.imapResponse);
      fn(err);
    }

    return;
  }

  try {
    await this.refreshSession(session, 'COPY');

    // check if over quota
    const { isOverQuota } = await Aliases.isOverQuota(
      {
        id: session.user.alias_id,
        domain: session.user.domain_id,
        locale: session.user.locale
      },
      0,
      this.client
    );

    if (isOverQuota)
      throw new IMAPError(
        i18n.translate('IMAP_MAILBOX_OVER_QUOTA', session.user.locale),
        {
          imapResponse: 'OVERQUOTA'
        }
      );

    const sourceIds = [];
    const sourceUid = [];
    const destinationUid = [];
    const entries = [];
    let copiedMessages = 0;
    let copiedStorage = 0;
    let err;
    let lock;

    const mailbox = await Mailboxes.findOne(this, session, {
      _id: mailboxId
    });

    if (!mailbox)
      throw new IMAPError(
        i18n.translate('IMAP_MAILBOX_DOES_NOT_EXIST', session.user.locale),
        {
          imapResponse: 'NONEXISTENT'
        }
      );

    const targetMailbox = await Mailboxes.findOne(this, session, {
      path: update.destination
    });

    if (!targetMailbox)
      throw new IMAPError(
        i18n.translate('IMAP_MAILBOX_DOES_NOT_EXIST', session.user.locale),
        {
          imapResponse: 'TRYCREATE'
        }
      );

    try {
      lock = await acquireLock(this, session.db);

      const condition = {
        mailbox: mailbox._id.toString()
      };

      // <https://github.com/nodemailer/wildduck/issues/698>
      if (update.messages.length > 0)
        condition.uid = tools.checkRangeQuery(update.messages);

      const sql = builder.build({
        type: 'select',
        table: 'Messages',
        condition,
        // sort required for IMAP UIDPLUS
        sort: 'uid'
      });

      let { uidNext } = targetMailbox;

      // const stmt = session.db.prepare(sql.query);
      // for (const m of stmt.iterate(sql.values))
      //
      // NOTE: this is inefficient but works for now
      //
      const messages = session.db.prepare(sql.query).all(sql.values);

      if (messages.length > 0)
        session.db
          .transaction((messages) => {
            for (const m of messages) {
              // don't copy in bulk so it doesn't get out of incremental uid sync
              const _id = new mongoose.Types.ObjectId();
              sourceUid.unshift(m.uid);
              sourceIds.push(m._id);
              destinationUid.unshift(uidNext);

              // copy the message and generate new id
              m._id = _id.toString();
              m.mailbox = targetMailbox._id.toString();
              m.uid = uidNext;
              m.exp = (
                typeof targetMailbox.retention === 'number'
                  ? targetMailbox.retention !== 0
                  : false
              )
                ? 1
                : 0;
              m.rdate = new Date(
                Date.now() +
                  (typeof targetMailbox.retention === 'number'
                    ? targetMailbox.retention
                    : 0)
              ).toISOString();
              m.modseq = mailbox.modifyIndex;
              m.junk = targetMailbox.specialUse === '\\Junk';
              m.remoteAddress = session.remoteAddress;
              m.transaction = 'COPY';

              // create new message
              {
                const sql = builder.build({
                  type: 'insert',
                  table: 'Messages',
                  values: m
                });
                session.db.prepare(sql.query).run(sql.values);
              }

              // update attachment store magic number
              const attachmentIds = getAttachments(m.mimeTree);
              if (attachmentIds.length > 0) {
                const sql = builder.build({
                  type: 'update',
                  table: 'Attachments',
                  condition: {
                    hash: {
                      $in: attachmentIds
                    }
                  },
                  modifier: {
                    $inc: {
                      counter: 1,
                      magic: m.magic
                    },
                    $set: {
                      counterUpdated: new Date().toString()
                    }
                  }
                });
                session.db.prepare(sql.query).run(sql.values);
              }

              // increase counters
              copiedMessages++;
              copiedStorage += m.size;
              uidNext++;

              // add entries
              entries.push({
                command: 'EXISTS',
                uid: m.uid,
                mailbox: targetMailbox._id,
                message: _id
                // thread: new mongoose.Types.ObjectId(m.thread),
                // unseen: boolean(m.unseen),
                // idate: new Date(m.idate),
                // junk: boolean(m.junk)
              });
            }

            // set all existing messages as copied
            {
              const sql = builder.build({
                type: 'update',
                table: 'Messages',
                condition: {
                  _id: {
                    $in: sourceIds
                  }
                },
                modifier: {
                  $set: {
                    copied: true
                  }
                }
              });
              session.db.prepare(sql.query).run(sql.values);
            }

            // store on target mailbox the final value of `uidNext`
            {
              const sql = builder.build({
                type: 'update',
                table: 'Mailboxes',
                condition: {
                  _id: targetMailbox._id.toString()
                },
                modifier: {
                  $set: {
                    uidNext
                  }
                }
              });
              session.db.prepare(sql.query).run(sql.values);
            }
          })
          .immediate(messages);
    } catch (_err) {
      err = _err;
    }

    // release lock
    if (lock?.success) {
      try {
        await releaseLock(this, session.db, lock);
      } catch (err) {
        this.logger.fatal(err, { mailboxId, update, session });
      }
    }

    if (err) throw err;

    // update quota if copied messages
    if (copiedMessages > 0 && copiedStorage > 0) {
      //
      // NOTE: we don't error for quota during copy due to this reasoning
      //       <https://github.com/nodemailer/wildduck/issues/517#issuecomment-1748329188>
      //
      Aliases.isOverQuota(
        {
          id: session.user.alias_id,
          domain: session.user.domain_id,
          locale: session.user.locale
        },
        copiedStorage,
        this.client
      )
        .then((results) => {
          if (results.isOverQuota) {
            const err = new IMAPError(
              i18n.translate(
                'IMAP_MAILBOX_MESSAGE_EXCEEDS_QUOTA',
                session.user.locale,
                session.user.username
              ),
              {
                imapResponse: 'OVERQUOTA',
                isCodeBug: true // admins will get an email/sms alert
              }
            );
            this.logger.fatal(err, {
              mailboxId,
              update,
              session
            });
          }
        })
        .catch((err) =>
          this.logger.fatal(err, {
            copiedStorage,
            connection,
            mailboxId,
            update,
            session
          })
        );

      // NOTE: we update storage used in real-time in `getDatabase`
      // add to `alias.storageSize` the message `size`
      // Aliases.findByIdAndUpdate(alias._id, {
      //   $inc: {
      //     storageUsed: copiedStorage
      //   }
      // })
      //   .then()
      //   .catch((err) =>
      //     this.logger.fatal(err, {
      //       copiedStorage,
      //       connection,
      //       mailboxId,
      //       update,
      //       session
      //     })
      //   );
    }

    // update storage
    try {
      session.db.pragma('wal_checkpoint(PASSIVE)');
      await updateStorageUsed(session.user.alias_id, this.client);
    } catch (err) {
      this.logger.fatal(err, { connection, mailboxId, update, session });
    }

    if (entries.length > 0) {
      await this.server.notifier.addEntries(
        this,
        session,
        targetMailbox._id,
        entries
      );
      this.server.notifier.fire(session.user.alias_id, update.destination);
    }

    fn(null, true, {
      uidValidity: targetMailbox.uidValidity,
      sourceUid,
      destinationUid
    });
  } catch (err) {
    fn(refineAndLogError(err, session, true, this));
  }
}

module.exports = onCopy;
