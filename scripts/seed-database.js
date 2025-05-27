// seed.js
const { faker } = require('@faker-js/faker');
const { Client } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Configuration
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'bulk_action_platform',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password123',
};

// Seed for deterministic faker data generation
// You can make this an environment variable if you want to easily change it
const FAKER_SEED = parseInt(process.env.FAKER_SEED) || 123; // Use a fixed seed for consistent data

const SEED_CONTACTS = parseInt(process.env.SEED_CONTACTS) || 1000;
const SEED_BULK_ACTIONS = parseInt(process.env.SEED_BULK_ACTIONS) || 50;
const BATCH_SIZE = 100;

const TEST_ACCOUNTS = [
  'test-account-1',
  'test-account-2',
  'test-account-3',
  'load-test-account',
  'demo-account',
  'performance-test-1',
  'performance-test-2',
  'rate-limit-test-1',
  'rate-limit-test-2',
  'integration-test',
];

class DatabaseSeeder {
  constructor() {
    this.client = new Client(config);
    // Set the faker seed here so all subsequent faker calls are deterministic
    faker.seed(FAKER_SEED);
  }

  async connect() {
    await this.client.connect();
    console.log('✅ Connected to DB');
  }

  async disconnect() {
    await this.client.end();
    console.log('✅ Disconnected from DB');
  }

  async clearExistingData() {
    // Clear bulk_action_stats first due to foreign key constraint
    await this.client.query(
      'DELETE FROM bulk_action_stats WHERE action_id IN (SELECT id FROM bulk_actions WHERE account_id LIKE $1)',
      ['%test%']
    );
    await this.client.query('DELETE FROM bulk_actions WHERE account_id LIKE $1', ['%test%']);
    // We need to be careful with contacts. If contacts don't have an account_id,
    // deleting all contacts might affect non-test data.
    // For deterministic IDs for contacts, we will also generate them.
    // To ensure the same contacts are inserted each time, we will replace the full DELETE
    // with an upsert (ON CONFLICT DO UPDATE) or selectively delete based on generated IDs if needed.
    // For now, let's assume `DELETE FROM contacts` is acceptable if you're always starting fresh for tests.
    // If you need to preserve other contacts, you'd need a more sophisticated cleanup strategy.
    await this.client.query('DELETE FROM contacts WHERE email LIKE $1', ['%@example.com']); // Assuming seeded emails use example.com
    console.log('🧹 Cleared previous test data');
  }

  async seedContacts() {
    console.log(`👥 Seeding ${SEED_CONTACTS} contacts...`);

    // To ensure deterministic UUIDs for contacts, we need to generate them deterministically
    // based on the faker seed or a sequential counter
    // For simplicity, let's make contact IDs based on a deterministic email or a sequential counter
    // For real UUIDs, we'd need a deterministic UUID generator or pre-defined UUIDs.
    // Given the request is to keep primary keys "same", for UUIDs, we'd typically need
    // to map a deterministic input to a UUID. For now, we'll use a sequential ID for contacts.

    // If your contact table has an auto-incrementing ID, then its ID will naturally
    // be consistent if the data inserted is always the same.
    // If you need a UUID for contacts, you'd generate it deterministically like this:
    // const uniqueContactIdentifier = `contact-${faker.string.uuid()}`; // this won't be deterministic without faker.seed on uuid()
    // For deterministic UUIDs, you might consider a library like 'uuid-js' or generate based on a seeded hash.
    // A simpler approach for consistent IDs is to use a sequential counter if your DB allows it.
    // Since your schema uses UUID for bulk_actions but not contacts, we'll assume contacts have
    // a serial primary key or you can manage their IDs deterministically.
    // For `contacts`, we'll make their emails deterministic so `ON CONFLICT (email) DO NOTHING` works consistently.

    for (let i = 0; i < SEED_CONTACTS; i += BATCH_SIZE) {
      const contacts = [];

      for (let j = 0; j < Math.min(BATCH_SIZE, SEED_CONTACTS - i); j++) {
        // Use a deterministic email format
        const deterministicEmail = `contact${i + j}@example.com`;
        contacts.push([
          faker.person.fullName(), // Name can still be random but linked to the seed
          deterministicEmail,
          faker.number.int({ min: 18, max: 80 }),
        ]);
      }

      const valuesPlaceholders = contacts
        .map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`)
        .join(', ');
      const flatParams = contacts.flat();

      const query = `
        INSERT INTO contacts (name, email, age)
        VALUES ${valuesPlaceholders}
        ON CONFLICT (email) DO NOTHING
      `;

      await this.client.query(query, flatParams);
    }

    console.log(`✅ Contacts seeded`);
  }

  async seedBulkActions() {
    console.log('⚙️  Seeding bulk actions and stats...');

    const statuses = [
      'completed',
      'failed',
      'processing',
      'queued',
      'cancelled',
      'scheduled',
      'validating',
    ];

    // To ensure same UUIDs for bulk actions, we need a deterministic way to generate them.
    // We'll use a seeded faker for the parts that make up the UUID or pre-generate a list.
    // Since `uuidv4()` is inherently random, we need to bypass it for deterministic IDs.
    // The easiest way to get deterministic UUIDs with faker is to use `faker.string.uuid()`
    // after seeding faker.

    for (let i = 0; i < SEED_BULK_ACTIONS; i++) {
      // Use faker.string.uuid() which respects the faker seed for deterministic UUIDs
      const actionId = faker.string.uuid();
      const accountId = faker.helpers.arrayElement(TEST_ACCOUNTS);
      const status = faker.helpers.arrayElement(statuses);
      const totalEntities = faker.number.int({ min: 100, max: 5000 });
      let startedAt = null;
      let completedAt = null;
      let errorMessage = null;
      let scheduledAt = null;
      let processedEntities = 0;

      switch (status) {
        case 'completed':
          processedEntities = totalEntities;
          startedAt = faker.date.recent({ days: 7 });
          completedAt = new Date(
            startedAt.getTime() + faker.number.int({ min: 30000, max: 600000 })
          );
          break;
        case 'failed':
          processedEntities = faker.number.int({ min: 0, max: totalEntities - 1 });
          startedAt = faker.date.recent({ days: 5 });
          completedAt = new Date(
            startedAt.getTime() + faker.number.int({ min: 10000, max: 180000 })
          );
          errorMessage = faker.lorem.sentence();
          break;
        case 'processing':
          processedEntities = faker.number.int({ min: 0, max: totalEntities });
          startedAt = faker.date.recent({ days: 2 });
          break;
        case 'cancelled':
          processedEntities = faker.number.int({ min: 0, max: totalEntities / 2 });
          startedAt = faker.date.recent({ days: 3 });
          completedAt = new Date(
            startedAt.getTime() + faker.number.int({ min: 5000, max: 120000 })
          );
          break;
        case 'queued':
          scheduledAt = faker.date.future({ years: 0.1 });
          break;
        case 'scheduled':
          scheduledAt = faker.date.future({ years: 0.1 });
          break;
        case 'validating':
          startedAt = faker.date.recent({ days: 1 });
          break;
        default:
          break;
      }

      const configuration = {
        deduplication: faker.datatype.boolean(),
      };

      const filePath = `/uploads/${accountId}/${actionId}.csv`;

      const actionInsert = `
        INSERT INTO bulk_actions (
          id, account_id, entity_type, action_type, status,
          total_entities, scheduled_at, started_at, completed_at,
          configuration, error_message, file_path, file_size,
          batch_size, retry_count, max_retries, priority
        ) VALUES (
          $1, $2, 'contact', 'bulk_update', $3,
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15
        )
        ON CONFLICT (id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          entity_type = EXCLUDED.entity_type,
          action_type = EXCLUDED.action_type,
          status = EXCLUDED.status,
          total_entities = EXCLUDED.total_entities,
          scheduled_at = EXCLUDED.scheduled_at,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          configuration = EXCLUDED.configuration,
          error_message = EXCLUDED.error_message,
          file_path = EXCLUDED.file_path,
          file_size = EXCLUDED.file_size,
          batch_size = EXCLUDED.batch_size,
          retry_count = EXCLUDED.retry_count,
          max_retries = EXCLUDED.max_retries,
          priority = EXCLUDED.priority
      `;

      const bulkActionParams = [
        actionId,
        accountId,
        status,
        totalEntities,
        scheduledAt,
        startedAt,
        completedAt,
        JSON.stringify(configuration),
        errorMessage,
        filePath,
        faker.number.int({ min: 1000, max: 1e6 }),
        faker.helpers.arrayElement([500, 1000, 2000]),
        status === 'failed' ? faker.number.int({ min: 1, max: 3 }) : 0,
        3,
        faker.number.int({ min: 1, max: 10 }),
      ];

      await this.client.query(actionInsert, bulkActionParams);

      // Seed bulk_action_stats
      let successfulRecords = 0;
      let failedRecords = 0;
      let skippedRecords = 0;

      if (status === 'completed') {
        successfulRecords = totalEntities;
      } else if (status === 'failed') {
        successfulRecords = processedEntities;
        failedRecords = totalEntities - processedEntities;
        skippedRecords = faker.number.int({ min: 0, max: Math.floor(failedRecords / 2) });
      } else if (status === 'cancelled') {
        successfulRecords = processedEntities;
        skippedRecords = totalEntities - processedEntities;
      } else if (status === 'processing' || status === 'validating') {
        successfulRecords = processedEntities;
        failedRecords = faker.number.int({ min: 0, max: Math.floor(totalEntities / 5) });
        skippedRecords = faker.number.int({ min: 0, max: Math.floor(totalEntities / 10) });
      } else {
        successfulRecords = 0;
        failedRecords = 0;
        skippedRecords = 0;
      }

      const statsInsert = `
        INSERT INTO bulk_action_stats (
          action_id, total_records, successful_records, failed_records, skipped_records
        ) VALUES (
          $1, $2, $3, $4, $5
        )
        ON CONFLICT (action_id) DO UPDATE SET
          total_records = EXCLUDED.total_records,
          successful_records = EXCLUDED.successful_records,
          failed_records = EXCLUDED.failed_records,
          skipped_records = EXCLUDED.skipped_records
      `;

      const statsParams = [
        actionId,
        totalEntities,
        successfulRecords,
        failedRecords,
        skippedRecords,
      ];

      await this.client.query(statsInsert, statsParams);
    }

    console.log('✅ Bulk actions + stats seeded');
  }

  async run() {
    try {
      await this.connect();
      await this.clearExistingData();
      await this.seedContacts();
      await this.seedBulkActions();
    } catch (err) {
      console.error('❌ Seeding failed:', err.message);
      if (err.detail) {
        console.error('DB Error Detail:', err.detail);
      }
    } finally {
      await this.disconnect();
    }
  }
}

new DatabaseSeeder().run();
