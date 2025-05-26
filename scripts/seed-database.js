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

const SEED_CONTACTS = parseInt(process.env.SEED_CONTACTS) || 1000;
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
    await this.client.query('DELETE FROM bulk_action_stats');
    await this.client.query('DELETE FROM bulk_actions WHERE account_id LIKE $1', ['%test%']);
    console.log('🧹 Cleared previous test data');
  }

  async seedContacts() {
    console.log(`👥 Seeding ${SEED_CONTACTS} contacts...`);

    for (let i = 0; i < SEED_CONTACTS; i += BATCH_SIZE) {
      const contacts = [];

      for (let j = 0; j < Math.min(BATCH_SIZE, SEED_CONTACTS - i); j++) {
        contacts.push([
          faker.person.fullName(),
          faker.internet.email().toLowerCase(),
          faker.number.int({ min: 18, max: 80 }),
        ]);
      }

      const values = contacts
        .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
        .join(', ');
      const flatParams = contacts.flat();

      const query = `
        INSERT INTO contacts (name, email, age)
        VALUES ${values}
        ON CONFLICT (email) DO NOTHING
      `;

      await this.client.query(query, flatParams);
    }

    console.log(`✅ Contacts seeded`);
  }

  async seedBulkActions() {
    console.log('⚙️  Seeding bulk actions and stats...');

    const statuses = ['completed', 'failed', 'processing', 'queued', 'cancelled'];

    for (let i = 0; i < 50; i++) {
      const accountId = faker.helpers.arrayElement(TEST_ACCOUNTS);
      const status = faker.helpers.arrayElement(statuses);
      const actionId = uuidv4();
      const totalEntities = faker.number.int({ min: 100, max: 5000 });
      let processedEntities = 0;
      let startedAt = null;
      let completedAt = null;
      let errorMessage = null;

      switch (status) {
        case 'completed':
          processedEntities = totalEntities;
          startedAt = faker.date.recent({ days: 7 });
          completedAt = new Date(
            startedAt.getTime() + faker.number.int({ min: 30000, max: 600000 })
          );
          break;
        case 'failed':
          processedEntities = faker.number.int({ min: 1, max: totalEntities - 1 });
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
        default:
          break;
      }

      const config = {
        fields: {
          company: faker.company.name(),
          status: faker.helpers.arrayElement(['active', 'inactive']),
        },
        deduplication: faker.datatype.boolean(),
      };

      const actionInsert = `
        INSERT INTO bulk_actions (
          id, account_id, entity_type, action_type, status,
          total_entities, processed_entities, scheduled_at, started_at, completed_at,
          configuration, error_message, file_path, file_size,
          batch_size, retry_count, max_retries, priority
        ) VALUES (
          $1, $2, 'contact', 'bulk_update', $3,
          $4, $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, 3, $15
        )
      `;

      const filePath = `/uploads/${accountId}/${actionId}.csv`;
      const scheduledAt = status === 'queued' ? faker.date.future() : null;

      await this.client.query(actionInsert, [
        actionId,
        accountId,
        status,
        totalEntities,
        processedEntities,
        scheduledAt,
        startedAt,
        completedAt,
        JSON.stringify(config),
        errorMessage,
        filePath,
        faker.number.int({ min: 1000, max: 1e6 }),
        faker.helpers.arrayElement([500, 1000, 2000]),
        status === 'failed' ? 1 : 0,
        faker.number.int({ min: 1, max: 10 }),
      ]);

      const statsInsert = `
        INSERT INTO bulk_action_stats (
          action_id, total_records, successful_records, failed_records, skipped_records, duplicate_records,
          validation_errors, database_errors, business_logic_errors, system_errors
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10
        )
      `;

      await this.client.query(statsInsert, [
        actionId,
        totalEntities,
        processedEntities,
        faker.number.int({ min: 0, max: 100 }),
        faker.number.int({ min: 0, max: 50 }),
        faker.number.int({ min: 0, max: 30 }),
        faker.number.int({ min: 0, max: 20 }),
        faker.number.int({ min: 0, max: 10 }),
        faker.number.int({ min: 0, max: 5 }),
        faker.number.int({ min: 0, max: 2 }),
      ]);
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
    } finally {
      await this.disconnect();
    }
  }
}

new DatabaseSeeder().run();
