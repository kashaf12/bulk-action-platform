/**
 * Business logic service for contacts
 * Implements contact-specific business rules and operations
 */

import { ContactRepository, ContactSearchParams } from '../repositories/ContactRepository';
import { Contact } from '../models/Contact';
import { IContact, ContactCreateData, ContactUpdateData } from '../types/entities/contact';
import { PaginationParams, PaginatedResult } from '../types';
import { ValidationError, NotFoundError, ConflictError } from '../utils/error';
import { logger } from '../utils/logger';
import { IService } from '../types/services';

export interface BulkContactUpdateResult {
  updated: IContact[];
  failed: Array<{ contact: IContact; error: string }>;
  totalProcessed: number;
  successCount: number;
  failureCount: number;
}

export interface ContactListOptions extends PaginationParams {
  search?: string;
}

export interface BulkContactOperation {
  created: IContact[];
  updated: IContact[];
  skipped: IContact[];
  errors: Array<{ contact: IContact; error: string }>;
}

export class ContactService implements IService {
  private contactRepository: ContactRepository;

  constructor(contactRepository: ContactRepository) {
    this.contactRepository = contactRepository || new ContactRepository();
  }

  /**
   * Get paginated list of contacts with search and filtering
   */
  public async getContacts(
    options: ContactListOptions,
    traceId: string
  ): Promise<PaginatedResult<IContact>> {
    this.validatePaginationParams(options.page, options.limit);

    const log = logger.withTrace(traceId);

    log.info('Fetching contacts', {
      page: options.page,
      limit: options.limit,
      filters: {
        search: options.search,
      },
    });

    try {
      const searchParams: ContactSearchParams = {
        page: options.page,
        limit: options.limit,
        search: options.search,
      };

      const result = await this.contactRepository.findWithSearch(searchParams, traceId);

      log.info('Successfully fetched contacts', {
        total: result.pagination.total,
        returned: result.data.length,
        page: result.pagination.page,
      });

      return result;
    } catch (error) {
      log.error('Failed to get contacts', {
        error: error instanceof Error ? error.message : String(error),
        options,
      });
      throw error;
    }
  }

  /**
   * Get contact by ID
   */
  public async getContactById(id: string, traceId: string): Promise<IContact> {
    if (!id) {
      throw new ValidationError('Contact ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Fetching contact by ID', { id });

    try {
      const contact = await this.contactRepository.findById(id, traceId);

      if (!contact) {
        throw new NotFoundError('Contact');
      }

      log.info('Successfully fetched contact', {
        id,
        email: contact.email,
      });

      return contact;
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.withTrace(traceId).warn('Contact not found', { id });
      } else {
        logger.withTrace(traceId).error('Failed to get contact by ID', {
          error: error instanceof Error ? error.message : String(error),
          id,
        });
      }
      throw error;
    }
  }

  /**
   * Get contact by email
   */
  public async getContactByEmail(email: string, traceId: string): Promise<IContact | null> {
    if (!email) {
      throw new ValidationError('Email is required');
    }

    const log = logger.withTrace(traceId);

    try {
      const contact = await this.contactRepository.findByEmail(email, traceId);

      log.debug('Contact lookup by email completed', {
        email,
        found: !!contact,
      });

      return contact;
    } catch (error) {
      log.error('Failed to get contact by email', {
        error: error instanceof Error ? error.message : String(error),
        email,
      });
      throw error;
    }
  }

  /**
   * Create a new contact
   */
  public async createContact(data: ContactCreateData, traceId: string): Promise<IContact> {
    const log = logger.withTrace(traceId);

    log.info('Creating contact', {
      email: data.email,
      name: data.name,
    });

    try {
      // Check if contact with email already exists
      const existingContact = await this.contactRepository.findByEmail(data.email, traceId);

      if (existingContact) {
        throw new ConflictError(`Contact with email ${data.email} already exists`);
      }

      // Create contact entity
      const contact = new Contact(data as IContact);

      // Validate entity
      const validation = Contact.validate(contact.toObject());
      if (!validation.isValid) {
        throw new ValidationError('Invalid contact data', validation.errors);
      }

      // Save to database
      const createdContact = await this.contactRepository.create(contact, traceId);

      log.info('Contact created successfully', {
        id: createdContact.id,
        email: createdContact.email,
        name: createdContact.name,
      });

      return createdContact;
    } catch (error) {
      log.error('Failed to create contact', {
        error: error instanceof Error ? error.message : String(error),
        data,
      });
      throw error;
    }
  }

  /**
   * Update a contact
   */
  public async updateContact(
    id: string,
    data: ContactUpdateData,
    traceId: string
  ): Promise<IContact> {
    if (!id) {
      throw new ValidationError('Contact ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Updating contact', {
      id,
      updates: Object.keys(data),
    });

    try {
      // Check if contact exists
      const existingContact = await this.contactRepository.findById(id, traceId);

      if (!existingContact) {
        throw new NotFoundError('Contact');
      }

      // If email is being updated, check for conflicts
      if (data.email && data.email !== existingContact.email) {
        const emailConflict = await this.contactRepository.findByEmail(data.email, traceId);
        if (emailConflict && emailConflict.id !== id) {
          throw new ConflictError(`Contact with email ${data.email} already exists`);
        }
      }

      // Validate update data
      const updatedContactData = { ...existingContact, ...data };
      const validation = Contact.validate(updatedContactData);
      if (!validation.isValid) {
        throw new ValidationError('Invalid contact update data', validation.errors);
      }

      // Perform update
      const updatedContact = await this.contactRepository.update(id, data, traceId);

      if (!updatedContact) {
        throw new NotFoundError('Contact');
      }

      log.info('Contact updated successfully', {
        id,
        email: updatedContact.email,
        updatedFields: Object.keys(data),
      });

      return updatedContact;
    } catch (error) {
      log.error('Failed to update contact', {
        error: error instanceof Error ? error.message : String(error),
        id,
        data,
      });
      throw error;
    }
  }

  /**
   * Delete a contact
   */
  public async deleteContact(id: string, traceId: string): Promise<void> {
    if (!id) {
      throw new ValidationError('Contact ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Deleting contact', { id });

    try {
      const deleted = await this.contactRepository.delete(id, traceId);

      if (!deleted) {
        throw new NotFoundError('Contact');
      }

      log.info('Contact deleted successfully', { id });
    } catch (error) {
      log.error('Failed to delete contact', {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw error;
    }
  }

  /**
   * Bulk create contacts with deduplication
   */
  public async bulkCreateContacts(
    contacts: ContactCreateData[],
    onConflict: 'skip' | 'update' | 'error' = 'skip',
    traceId: string
  ): Promise<BulkContactOperation> {
    const log = logger.withTrace(traceId);

    if (contacts.length === 0) {
      return { created: [], updated: [], skipped: [], errors: [] };
    }

    log.info('Starting bulk contact creation', {
      count: contacts.length,
      onConflict,
    });

    try {
      // Validate all contacts first
      const validatedContacts: IContact[] = [];
      const validationErrors: Array<{ contact: ContactCreateData; error: string }> = [];

      for (const contactData of contacts) {
        try {
          const contact = new Contact(contactData as IContact);
          const validation = Contact.validate(contact.toObject());

          if (!validation.isValid) {
            validationErrors.push({
              contact: contactData,
              error: `Validation failed: ${validation.errors.join(', ')}`,
            });
          } else {
            validatedContacts.push(contact);
          }
        } catch (error) {
          validationErrors.push({
            contact: contactData,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Perform bulk operation on validated contacts
      const result = await this.contactRepository.bulkCreate(
        validatedContacts,
        onConflict,
        traceId
      );

      // Add validation errors to the result
      const finalResult: BulkContactOperation = {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        errors: [
          ...result.errors,
          ...validationErrors.map(ve => ({
            contact: ve.contact as IContact,
            error: ve.error,
          })),
        ],
      };

      log.info('Bulk contact creation completed', {
        totalContacts: contacts.length,
        created: finalResult.created.length,
        updated: finalResult.updated.length,
        skipped: finalResult.skipped.length,
        errors: finalResult.errors.length,
        validationErrors: validationErrors.length,
        onConflict,
      });

      return finalResult;
    } catch (error) {
      log.error('Failed to bulk create contacts', {
        error: error instanceof Error ? error.message : String(error),
        contactCount: contacts.length,
        onConflict,
      });
      throw error;
    }
  }

  /**
   * Bulk update contacts
   */
  public async bulkUpdateContacts(
    contacts: ContactUpdateData[],
    traceId: string
  ): Promise<BulkContactUpdateResult> {
    const log = logger.withTrace(traceId);

    if (contacts.length === 0) {
      return { updated: [], failed: [], totalProcessed: 0, successCount: 0, failureCount: 0 };
    }

    log.info('Starting bulk contact update (update-only)', {
      count: contacts.length,
    });

    try {
      // Validate all contacts first
      const validatedContacts: IContact[] = [];
      const validationErrors: Array<{ contact: IContact; error: string }> = [];

      for (const contactData of contacts) {
        try {
          const contact = new Contact(contactData as IContact);
          const validation = Contact.validate(contact.toObject());

          if (!validation.isValid) {
            validationErrors.push({
              contact: contactData as IContact,
              error: `Validation failed: ${validation.errors.join(', ')}`,
            });
          } else {
            validatedContacts.push(contact.toObject() as unknown as IContact);
          }
        } catch (error) {
          validationErrors.push({
            contact: contactData as IContact,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Perform bulk update only on validated contacts
      let result: BulkContactUpdateResult;

      if (validatedContacts.length > 0) {
        const updateResult = await this.contactRepository.bulkUpdateOnly(
          validatedContacts,
          traceId
        );
        result = {
          updated: updateResult.updated,
          failed: [...updateResult.failed, ...validationErrors],
          totalProcessed: contacts.length,
          successCount: updateResult.successCount,
          failureCount: updateResult.failureCount + validationErrors.length,
        };
      } else {
        result = {
          updated: [],
          failed: validationErrors,
          totalProcessed: contacts.length,
          successCount: 0,
          failureCount: validationErrors.length,
        };
      }

      log.info('Bulk contact update completed', {
        totalContacts: contacts.length,
        updated: result.updated.length,
        failed: result.failed.length,
        validationErrors: validationErrors.length,
      });

      return result;
    } catch (error) {
      log.error('Failed to bulk update contacts', {
        error: error instanceof Error ? error.message : String(error),
        contactCount: contacts.length,
      });
      throw error;
    }
  }

  /**
   * Find contacts by multiple emails (for deduplication)
   */
  public async findContactsByEmails(emails: string[], traceId: string): Promise<IContact[]> {
    const log = logger.withTrace(traceId);

    if (emails.length === 0) {
      return [];
    }

    try {
      const contacts = await this.contactRepository.findByEmails(emails, traceId);

      log.debug('Bulk email lookup completed', {
        searchCount: emails.length,
        foundCount: contacts.length,
      });

      return contacts;
    } catch (error) {
      log.error('Failed to find contacts by emails', {
        error: error instanceof Error ? error.message : String(error),
        emailCount: emails.length,
      });
      throw error;
    }
  }

  /**
   * Validate pagination parameters
   */
  private validatePaginationParams(page: number, limit: number): void {
    if (page < 1) {
      throw new ValidationError('Page must be at least 1');
    }

    if (limit < 1 || limit > 100) {
      throw new ValidationError('Limit must be between 1 and 100');
    }
  }
}
