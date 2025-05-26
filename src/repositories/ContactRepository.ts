/**
 * Contact repository implementation
 * Handles contact-specific database operations
 */

import { BaseRepository } from '../core/BaseRepository';
import { Contact } from '../models/Contact';
import { IContact } from '../types/entities/contact';
import { PaginationParams, PaginatedResult } from '../types';
import { logger } from '../utils/logger';
import { DatabaseError } from '../utils/error';
import database from '../config/database';

export interface ContactSearchParams extends PaginationParams {
  search?: string;
  email?: string;
}

export class ContactRepository extends BaseRepository<IContact> {
  constructor() {
    super(Contact);
  }

  /**
   * Implementation of abstract method from BaseRepository
   * Creates Contact instance from database row using type-safe factory method
   */
  protected createEntityFromRow(row: Record<string, unknown>): IContact {
    return Contact.fromDbRow(row);
  }

  /**
   * Find contacts with advanced search capabilities
   */
  public async findWithSearch(
    params: ContactSearchParams,
    traceId: string
  ): Promise<PaginatedResult<IContact>> {
    const log = logger.withTrace(traceId);

    try {
      const { page, limit, search, email, ...otherFilters } = params;
      const offset = (page - 1) * limit;

      // Build dynamic WHERE conditions
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      let paramIndex = 1;

      // Add basic filters

      if (email) {
        conditions.push(`email = $${paramIndex}`);
        queryParams.push(email.toLowerCase());
        paramIndex++;
      }

      // Add search functionality (name or email)
      if (search) {
        conditions.push(`(name ILIKE $${paramIndex} OR email ILIKE $${paramIndex + 1})`);
        queryParams.push(`%${search}%`, `%${search}%`);
        paramIndex += 2;
      }

      // Add other filters from base method
      for (const [field, value] of Object.entries(otherFilters)) {
        const columnMappings = Contact.getColumnMappings();
        const column = columnMappings[field];
        if (column && value !== undefined && value !== null) {
          conditions.push(`${column} = $${paramIndex}`);
          queryParams.push(value);
          paramIndex++;
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count total records
      const countQuery = `SELECT COUNT(*) as total FROM contacts ${whereClause}`;
      const countResult = await database.query(countQuery, queryParams, traceId);
      const total = parseInt(countResult.rows[0]?.total || '0');

      // Fetch paginated data
      const dataQuery = `
        SELECT 
          id, name, email, age, 
          created_at, updated_at
        FROM contacts 
        ${whereClause}
        ORDER BY 
          CASE WHEN status = 'active' THEN 1 ELSE 2 END,
          created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      const dataResult = await database.query(dataQuery, [...queryParams, limit, offset], traceId);

      // Convert to Contact instances using type-safe factory method
      const contacts = dataResult.rows.map(row => Contact.fromDbRow(row));

      const totalPages = Math.ceil(total / limit);

      log.debug('Contact search completed', {
        total,
        returned: contacts.length,
        searchParams: { search, email },
      });

      return {
        data: contacts,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      };
    } catch (error) {
      log.error('Contact search failed', {
        error: error instanceof Error ? error.message : String(error),
        params,
      });
      throw new DatabaseError(`Contact search failed: ${error}`);
    }
  }

  /**
   * Find contact by email (for deduplication)
   */
  public async findByEmail(email: string, traceId: string): Promise<IContact | null> {
    const log = logger.withTrace(traceId);

    try {
      const query = `
        SELECT id, name, email, age, created_at, updated_at
        FROM contacts 
        WHERE email = $1
      `;

      const result = await database.query(query, [email.toLowerCase()], traceId);

      if (result.rows.length === 0) {
        return null;
      }
      const row = result.rows[0];
      if (!row) {
        log.warn('Multiple contacts found for email', {
          email,
          count: result.rows.length,
        });
        return null;
      }

      const contact = Contact.fromDbRow(row);

      log.debug('Contact found by email', {
        email,
        contactId: contact.id,
      });

      return contact;
    } catch (error) {
      log.error('Find contact by email failed', {
        error: error instanceof Error ? error.message : String(error),
        email,
      });
      throw new DatabaseError(`Find contact by email failed: ${error}`);
    }
  }

  /**
   * Find contacts by multiple emails (bulk lookup for deduplication)
   */
  public async findByEmails(emails: string[], traceId: string): Promise<IContact[]> {
    const log = logger.withTrace(traceId);

    if (emails.length === 0) {
      return [];
    }

    try {
      const normalizedEmails = emails.map(email => email.toLowerCase());
      const placeholders = normalizedEmails.map((_, index) => `$${index + 1}`).join(',');

      const query = `
        SELECT id, name, email, age, created_at, updated_at
        FROM contacts 
        WHERE email = ANY(ARRAY[${placeholders}])
      `;

      const result = await database.query(query, normalizedEmails, traceId);
      const contacts = result.rows.map(row => Contact.fromDbRow(row));

      log.debug('Bulk email lookup completed', {
        searchCount: emails.length,
        foundCount: contacts.length,
      });

      return contacts;
    } catch (error) {
      log.error('Bulk email lookup failed', {
        error: error instanceof Error ? error.message : String(error),
        emailCount: emails.length,
      });
      throw new DatabaseError(`Bulk email lookup failed: ${error}`);
    }
  }

  /**
   * Get contact statistics by status
   */
  public async getStatusStatistics(traceId: string): Promise<Record<string, number>> {
    const log = logger.withTrace(traceId);

    try {
      const query = `
        SELECT 
          status,
          COUNT(*) as count
        FROM contacts 
        GROUP BY status
        ORDER BY status
      `;

      const result = await database.query(query, [], traceId);
      const stats: Record<string, number> = {};

      for (const row of result.rows) {
        stats[row.status] = parseInt(row.count);
      }

      log.debug('Contact status statistics retrieved', { stats });

      return stats;
    } catch (error) {
      log.error('Failed to get contact status statistics', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DatabaseError(`Failed to get contact statistics: ${error}`);
    }
  }

  /**
   * Bulk create contacts with conflict resolution
   */
  public async bulkCreate(
    contacts: IContact[],
    onConflict: 'skip' | 'update' | 'error' = 'skip',
    traceId: string
  ): Promise<{
    created: IContact[];
    updated: IContact[];
    skipped: IContact[];
    errors: Array<{ contact: IContact; error: string }>;
  }> {
    const log = logger.withTrace(traceId);

    if (contacts.length === 0) {
      return { created: [], updated: [], skipped: [], errors: [] };
    }

    const result = {
      created: [] as IContact[],
      updated: [] as IContact[],
      skipped: [] as IContact[],
      errors: [] as Array<{ contact: IContact; error: string }>,
    };

    try {
      const client = await database.getClient();

      try {
        await client.query('BEGIN');

        for (const contact of contacts) {
          try {
            const contactEntity = new Contact(contact);
            const dbObject = contactEntity.toDbObject();

            let query: string;
            let values: unknown[];

            if (onConflict === 'skip') {
              query = `
                INSERT INTO contacts (name, email, age)
                VALUES ($1, $2, $3)
                ON CONFLICT (email) DO NOTHING
                RETURNING id, name, email, age, created_at, updated_at
              `;
              values = [dbObject.name, dbObject.email, dbObject.age];
            } else if (onConflict === 'update') {
              query = `
                INSERT INTO contacts (name, email, age)
                VALUES ($1, $2, $3)
                ON CONFLICT (email) DO UPDATE SET
                  name = EXCLUDED.name,
                  age = EXCLUDED.age,
                  updated_at = NOW()
                RETURNING id, name, email, age, created_at, updated_at
              `;
              values = [dbObject.name, dbObject.email, dbObject.age];
            } else {
              // onConflict === 'error'
              query = `
                INSERT INTO contacts (name, email, age)
                VALUES ($1, $2, $3)
                RETURNING id, name, email, age, created_at, updated_at
              `;
              values = [dbObject.name, dbObject.email, dbObject.age];
            }

            const insertResult = await client.query(query, values);

            if (insertResult.rows.length > 0) {
              const createdContact = Contact.fromDbRow(insertResult.rows[0]);

              // Check if this was an update (compare timestamps)
              const isUpdate = insertResult.rows[0].created_at !== insertResult.rows[0].updated_at;

              if (isUpdate && onConflict === 'update') {
                result.updated.push(createdContact);
              } else {
                result.created.push(createdContact);
              }
            } else {
              // Row was skipped due to conflict
              result.skipped.push(contact);
            }
          } catch (contactError) {
            result.errors.push({
              contact,
              error: contactError instanceof Error ? contactError.message : String(contactError),
            });
          }
        }

        await client.query('COMMIT');

        log.info('Bulk contact creation completed', {
          totalContacts: contacts.length,
          created: result.created.length,
          updated: result.updated.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          onConflict,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      log.error('Bulk contact creation failed', {
        error: error instanceof Error ? error.message : String(error),
        contactCount: contacts.length,
        onConflict,
      });
      throw new DatabaseError(`Bulk contact creation failed: ${error}`);
    }

    return result;
  }

  /**
   * Update multiple contacts by IDs
   */
  public async bulkUpdate(
    updates: Array<{ id: string; data: Partial<IContact> }>,
    traceId: string
  ): Promise<{
    updated: IContact[];
    notFound: string[];
    errors: Array<{ id: string; error: string }>;
  }> {
    const log = logger.withTrace(traceId);

    const result = {
      updated: [] as IContact[],
      notFound: [] as string[],
      errors: [] as Array<{ id: string; error: string }>,
    };

    if (updates.length === 0) {
      return result;
    }

    try {
      const client = await database.getClient();

      try {
        await client.query('BEGIN');

        for (const { id, data } of updates) {
          try {
            const updatedContact = await this.update(id, data, traceId);

            if (updatedContact) {
              result.updated.push(updatedContact);
            } else {
              result.notFound.push(id);
            }
          } catch (updateError) {
            result.errors.push({
              id,
              error: updateError instanceof Error ? updateError.message : String(updateError),
            });
          }
        }

        await client.query('COMMIT');

        log.info('Bulk contact update completed', {
          totalUpdates: updates.length,
          updated: result.updated.length,
          notFound: result.notFound.length,
          errors: result.errors.length,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      log.error('Bulk contact update failed', {
        error: error instanceof Error ? error.message : String(error),
        updateCount: updates.length,
      });
      throw new DatabaseError(`Bulk contact update failed: ${error}`);
    }

    return result;
  }

  public async bulkUpdateOnly(
    contacts: IContact[],
    traceId?: string
  ): Promise<{
    updated: IContact[];
    failed: Array<{ contact: IContact; error: string }>;
    totalProcessed: number;
    successCount: number;
    failureCount: number;
  }> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    if (contacts.length === 0) {
      return { updated: [], failed: [], totalProcessed: 0, successCount: 0, failureCount: 0 };
    }

    try {
      // Build parameterized query for bulk update with RETURNING
      const updateCases: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      for (const contact of contacts) {
        updateCases.push(
          `($${paramIndex}::uuid, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3})`
        );
        params.push(contact.id, contact.email, contact.name, contact.age);
        paramIndex += 4;
      }

      const query = `
        UPDATE contacts 
        SET 
          name = data.name,
          age = data.age::integer,
          updated_at = NOW()
        FROM (VALUES ${updateCases.join(', ')}) AS data(id, email, name, age)
        WHERE contacts.id = data.id
        RETURNING contacts.*
      `;

      const result = await database.query(query, params);

      const updatedContacts = result.rows;

      // Find missing contacts (contacts that were not updated)
      const updatedEmails = new Set(updatedContacts.map(c => c.email));
      const missingContacts = contacts.filter(c => !updatedEmails.has(c.email));

      // Mark missing contacts as failed
      const failed = missingContacts.map(contact => ({
        contact,
        error: `Contact with email ${contact.email} not found for update`,
      }));

      log.info('Bulk update only completed', {
        totalProcessed: contacts.length,
        updated: updatedContacts.length,
        failed: failed.length,
      });

      return {
        updated: updatedContacts.map(row => Contact.fromDbRow(row)),
        failed,
        totalProcessed: contacts.length,
        successCount: updatedContacts.length,
        failureCount: failed.length,
      };
    } catch (error) {
      log.error('Bulk update only failed', {
        error: error instanceof Error ? error.message : String(error),
        contactCount: contacts.length,
      });
      throw new DatabaseError('Failed to bulk update contacts');
    }
  }
}
