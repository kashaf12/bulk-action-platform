/**
 * Contact entity implementation
 * Extends BaseEntity with contact-specific fields and validation
 */

import { z } from 'zod';
import { BaseEntity } from '../core/BaseEntity';
import { IContact } from '../types/entities/contact';
import { contactSchema } from '../schemas/entities/contact';
import { FieldValidators } from '../types';

export class Contact extends BaseEntity implements IContact {
  public name?: string;
  public email: string;
  public age?: number;

  constructor(data: IContact) {
    super(data);
    this.name = data.name;
    this.email = data.email;
    this.age = data.age;
  }

  public static getEntityType(): string {
    return 'contact';
  }

  public static getSchema(): z.ZodSchema {
    return contactSchema;
  }

  public static getRequiredFields(): string[] {
    return [...super.getRequiredFields(), 'email'];
  }

  public static getOptionalFields(): string[] {
    return [...super.getOptionalFields(), 'name', 'age'];
  }

  public static getFieldValidators(): FieldValidators {
    return {
      ...super.getFieldValidators(),
      email: (value: unknown): boolean => {
        if (typeof value !== 'string') return false;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(value);
      },
      age: (value: unknown): boolean => {
        if (typeof value !== 'number') return false;
        return Number.isInteger(value) && value > 0 && value < 150;
      },
    };
  }

  public static getUniqueFields(): string[] {
    return ['email'];
  }

  public static getTableName(): string {
    return 'contacts';
  }

  public static getColumnMappings(): Record<string, string> {
    return {
      ...super.getColumnMappings(),
      name: 'name',
      email: 'email',
      age: 'age',
    };
  }

  /**
   * Create Contact instance from database row
   * Type-safe factory method that replaces the generic fromDbRow
   */
  public static fromDbRow(row: Record<string, unknown>): Contact {
    const columnMappings = this.getColumnMappings();
    const entityData = this.mapDbRowToEntityData(row, columnMappings);

    // Validate required fields
    if (!entityData.email) {
      throw new Error('Contact requires email field');
    }

    // Create Contact with proper typing
    return new Contact(entityData as unknown as IContact);
  }

  public toObject(): Record<string, unknown> {
    return {
      ...super.toObject(),
      name: this.name,
      email: this.email,
      age: this.age,
    };
  }

  /**
   * Get display name for the contact
   */
  public getDisplayName(): string {
    return this.name || this.email.split('@')[0] || 'Unknown Contact';
  }

  /**
   * Get contact domain from email
   */
  public getDomain(): string {
    return this.email.split('@')[1] || '';
  }

  /**
   * Create contact instance from API data
   */
  public static fromApiData(data: Record<string, unknown>): Contact {
    const validation = this.safeParse(data);
    if (!validation.success) {
      throw new Error(`Invalid contact data: ${validation.errors?.join(', ')}`);
    }
    return new Contact(validation.data as IContact);
  }

  /**
   * Sanitize contact data for API response
   */
  public toApiResponse(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      age: this.age,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
