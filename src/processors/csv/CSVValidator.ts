/**
 * CSV Business Logic Validator
 * Validates CSV rows against entity schemas and business rules with detailed error reporting
 */

import { z } from 'zod';
import { EntityType } from '../../types/entities/bulk-action';
import { contactCreateSchema } from '../../schemas/entities/contact';
import { CSVRow, CSVHeader } from './CSVStreamReader';
import { ValidationError } from '../../utils/error';

export interface ValidationRule {
  field: string;
  required: boolean;
  validator: (value: string) => boolean;
  transformer?: (value: string) => unknown;
  errorMessage: string;
}

export interface ValidationResult {
  isValid: boolean;
  rowNumber: number;
  validatedData: Record<string, unknown>;
  errors: ValidationErrorType[];
  warnings: ValidationWarning[];
  transformedData: Record<string, unknown>;
}

export interface ValidationErrorType {
  field: string;
  value: string;
  code: ValidationErrorCode;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationWarning {
  field: string;
  value: string;
  message: string;
  suggestion?: string;
}

export enum ValidationErrorCode {
  REQUIRED_FIELD_MISSING = 'REQUIRED_FIELD_MISSING',
  INVALID_EMAIL_FORMAT = 'INVALID_EMAIL_FORMAT',
  INVALID_AGE_RANGE = 'INVALID_AGE_RANGE',
  FIELD_TOO_LONG = 'FIELD_TOO_LONG',
  FIELD_TOO_SHORT = 'FIELD_TOO_SHORT',
  INVALID_CHARACTER_SET = 'INVALID_CHARACTER_SET',
  BUSINESS_RULE_VIOLATION = 'BUSINESS_RULE_VIOLATION',
  DATA_TYPE_MISMATCH = 'DATA_TYPE_MISMATCH',
  SUSPICIOUS_CONTENT = 'SUSPICIOUS_CONTENT',
}

export interface ValidationConfig {
  entityType: EntityType;
  strictMode: boolean; // Fail fast on first error
  allowExtraFields: boolean; // Allow fields not in schema
  transformData: boolean; // Apply data transformations
  maxErrorsPerRow: number; // Maximum errors to collect per row
  businessRules: BusinessRule[];
}

export interface BusinessRule {
  name: string;
  description: string;
  validator: (data: Record<string, unknown>) => boolean;
  errorMessage: string;
  fields: string[]; // Fields this rule depends on
}

export interface ValidationStats {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  totalErrors: number;
  totalWarnings: number;
  errorBreakdown: Record<ValidationErrorCode, number>;
  fieldErrors: Record<string, number>;
  processingTime: number;
}

export class CSVValidator {
  private config: ValidationConfig;
  private validationRules: Map<string, ValidationRule>;
  private stats: ValidationStats;
  private entitySchema: z.ZodSchema;

  constructor(config: ValidationConfig) {
    this.config = config;
    this.validationRules = new Map();
    this.stats = this.initializeStats();
    this.entitySchema = this.getEntitySchema(config.entityType);

    this.setupValidationRules();
  }

  /**
   * Validate a single CSV row
   */
  public validateRow(row: CSVRow, header: CSVHeader): ValidationResult {
    const result: ValidationResult = {
      isValid: true,
      rowNumber: row.rowNumber,
      validatedData: {},
      errors: [],
      warnings: [],
      transformedData: {},
    };

    try {
      // Step 1: Map CSV row to entity fields
      const mappedData = this.mapRowToEntity(row.data, header);
      result.validatedData = mappedData;

      // Step 2: Validate required fields
      this.validateRequiredFields(mappedData, result);

      // Step 3: Validate field formats and types
      this.validateFieldFormats(mappedData, result);

      // Step 4: Apply data transformations
      if (this.config.transformData) {
        result.transformedData = this.transformRowData(mappedData, result);
      } else {
        result.transformedData = { ...mappedData };
      }

      // Step 5: Validate against entity schema
      this.validateAgainstSchema(result.transformedData, result);

      // Step 6: Apply business rules
      this.validateBusinessRules(result.transformedData, result);

      // Step 7: Security validation
      this.validateSecurity(mappedData, result);

      // Update result status
      result.isValid = result.errors.length === 0;

      // Update statistics
      this.updateStats(result);

      return result;
    } catch (error) {
      result.isValid = false;
      result.errors.push({
        field: 'row',
        value: row.rawLine,
        code: ValidationErrorCode.BUSINESS_RULE_VIOLATION,
        message: error instanceof Error ? error.message : 'Unknown validation error',
        severity: 'error',
      });

      this.updateStats(result);
      return result;
    }
  }

  /**
   * Batch validate multiple rows
   */
  public async validateBatch(
    rows: CSVRow[],
    header: CSVHeader,
    onProgress?: (progress: { processed: number; total: number; errors: number }) => void
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    let errorCount = 0;

    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      const result = this.validateRow(rows[i]!, header);
      results.push(result);

      if (!result.isValid) {
        errorCount++;
      }

      // Report progress
      if (onProgress && (i % 100 === 0 || i === rows.length - 1)) {
        onProgress({
          processed: i + 1,
          total: rows.length,
          errors: errorCount,
        });
      }

      // Early exit in strict mode if too many errors
      if (this.config.strictMode && errorCount > rows.length * 0.1) {
        throw new ValidationError(`Too many validation errors: ${errorCount}/${i + 1} rows failed`);
      }
    }

    return results;
  }

  /**
   * Get validation statistics
   */
  public getStats(): ValidationStats {
    return { ...this.stats };
  }

  /**
   * Reset validation statistics
   */
  public resetStats(): void {
    this.stats = this.initializeStats();
  }

  /**
   * Get sample validation errors for debugging
   */
  public getSampleErrors(maxSamples: number = 10): ValidationError[] {
    // This would return a sample of errors collected during validation
    // Implementation would maintain a ring buffer of recent errors
    return [];
  }

  /**
   * Map CSV row data to entity fields
   */
  private mapRowToEntity(
    rowData: Record<string, string>,
    header: CSVHeader
  ): Record<string, unknown> {
    const mappedData: Record<string, unknown> = {};

    // Map known fields based on entity type
    const fieldMappings = this.getFieldMappings(this.config.entityType);

    for (const [csvField, entityField] of fieldMappings) {
      const normalizedCsvField = csvField.toLowerCase().trim();
      const columnIndex = header.columnMap.get(normalizedCsvField);

      if (columnIndex !== undefined) {
        const value = rowData[header.columns[columnIndex]!];
        if (value !== undefined) {
          mappedData[entityField] = value.trim();
        }
      }
    }

    // Include extra fields if allowed
    if (this.config.allowExtraFields) {
      for (const [csvField, value] of Object.entries(rowData)) {
        const normalizedField = csvField.toLowerCase().trim();
        if (!fieldMappings.has(normalizedField)) {
          mappedData[normalizedField] = value.trim();
        }
      }
    }

    return mappedData;
  }

  /**
   * Validate required fields
   */
  private validateRequiredFields(data: Record<string, unknown>, result: ValidationResult): void {
    const requiredFields = this.getRequiredFields(this.config.entityType);

    for (const field of requiredFields) {
      const value = data[field];

      if (value === undefined || value === null || value === '') {
        result.errors.push({
          field,
          value: String(value || ''),
          code: ValidationErrorCode.REQUIRED_FIELD_MISSING,
          message: `Required field '${field}' is missing or empty`,
          severity: 'error',
        });
      }
    }
  }

  /**
   * Validate field formats and types
   */
  private validateFieldFormats(data: Record<string, unknown>, result: ValidationResult): void {
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }

      const rule = this.validationRules.get(field);
      if (!rule) {
        continue;
      }

      const stringValue = String(value);

      // Apply field-specific validation
      if (!rule.validator(stringValue)) {
        result.errors.push({
          field,
          value: stringValue,
          code: this.getValidationErrorCode(field),
          message: rule.errorMessage,
          severity: 'error',
        });
      }

      // Check field length constraints
      this.validateFieldLength(field, stringValue, result);

      // Check for suspicious content
      this.validateFieldSecurity(field, stringValue, result);
    }
  }

  /**
   * Transform row data based on field transformers
   */
  private transformRowData(
    data: Record<string, unknown>,
    result: ValidationResult
  ): Record<string, unknown> {
    const transformed: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(data)) {
      if (value === undefined || value === null) {
        transformed[field] = value;
        continue;
      }

      const rule = this.validationRules.get(field);
      if (rule?.transformer) {
        try {
          transformed[field] = rule.transformer(String(value));
        } catch (error) {
          transformed[field] = value;
          result.warnings.push({
            field,
            value: String(value),
            message: `Failed to transform field: ${error instanceof Error ? error.message : 'Unknown error'}`,
            suggestion: `Please check the format of ${field}`,
          });
        }
      } else {
        transformed[field] = value;
      }
    }

    return transformed;
  }

  /**
   * Validate against entity schema
   */
  private validateAgainstSchema(data: Record<string, unknown>, result: ValidationResult): void {
    try {
      const parseResult = this.entitySchema.safeParse(data);

      if (!parseResult.success) {
        for (const error of parseResult.error.errors) {
          result.errors.push({
            field: error.path.join('.'),
            value: String(data[error.path[0]!] || ''),
            code: ValidationErrorCode.DATA_TYPE_MISMATCH,
            message: error.message,
            severity: 'error',
          });
        }
      }
    } catch (error) {
      result.errors.push({
        field: 'schema',
        value: JSON.stringify(data),
        code: ValidationErrorCode.BUSINESS_RULE_VIOLATION,
        message: `Schema validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        severity: 'error',
      });
    }
  }

  /**
   * Apply business rules validation
   */
  private validateBusinessRules(data: Record<string, unknown>, result: ValidationResult): void {
    for (const rule of this.config.businessRules) {
      try {
        if (!rule.validator(data)) {
          result.errors.push({
            field: rule.fields.join(','),
            value: rule.fields.map(f => String(data[f] || '')).join(','),
            code: ValidationErrorCode.BUSINESS_RULE_VIOLATION,
            message: rule.errorMessage,
            severity: 'error',
          });
        }
      } catch (error) {
        result.warnings.push({
          field: rule.fields.join(','),
          value: rule.fields.map(f => String(data[f] || '')).join(','),
          message: `Business rule '${rule.name}' evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }
  }

  /**
   * Security validation for potential malicious content
   */
  private validateSecurity(data: Record<string, unknown>, result: ValidationResult): void {
    const suspiciousPatterns = [
      { pattern: /^=.*/, message: 'Excel formula detected' },
      { pattern: /^@.*/, message: 'Excel function detected' },
      { pattern: /^\+.*/, message: 'Excel formula detected' },
      { pattern: /^-.*/, message: 'Excel formula detected' },
      { pattern: /<script/i, message: 'Script tag detected' },
      { pattern: /javascript:/i, message: 'JavaScript protocol detected' },
      { pattern: /data:.*base64/i, message: 'Base64 data URI detected' },
    ];

    for (const [field, value] of Object.entries(data)) {
      if (typeof value !== 'string') continue;

      for (const { pattern, message } of suspiciousPatterns) {
        if (pattern.test(value)) {
          result.errors.push({
            field,
            value,
            code: ValidationErrorCode.SUSPICIOUS_CONTENT,
            message: `Security violation: ${message}`,
            severity: 'error',
          });
        }
      }
    }
  }

  /**
   * Validate field length constraints
   */
  private validateFieldLength(field: string, value: string, result: ValidationResult): void {
    const constraints = this.getFieldConstraints(field);

    if (constraints.maxLength && value.length > constraints.maxLength) {
      result.errors.push({
        field,
        value: value.substring(0, 50) + '...', // Truncate for logging
        code: ValidationErrorCode.FIELD_TOO_LONG,
        message: `Field '${field}' exceeds maximum length of ${constraints.maxLength}`,
        severity: 'error',
      });
    }

    if (constraints.minLength && value.length < constraints.minLength) {
      result.errors.push({
        field,
        value,
        code: ValidationErrorCode.FIELD_TOO_SHORT,
        message: `Field '${field}' is shorter than minimum length of ${constraints.minLength}`,
        severity: 'error',
      });
    }
  }

  /**
   * Validate field for security issues
   */
  private validateFieldSecurity(field: string, value: string, result: ValidationResult): void {
    // Check for control characters
    if (/[\x00-\x1F\x7F-\x9F]/.test(value)) {
      result.warnings.push({
        field,
        value: value.substring(0, 20),
        message: 'Field contains control characters',
        suggestion: 'Remove non-printable characters',
      });
    }

    // Check for excessive whitespace
    if (value.trim().length < value.length * 0.8) {
      result.warnings.push({
        field,
        value: value.substring(0, 20),
        message: 'Field contains excessive whitespace',
        suggestion: 'Trim unnecessary spaces',
      });
    }
  }

  /**
   * Setup validation rules for entity type
   */
  private setupValidationRules(): void {
    switch (this.config.entityType) {
      case 'contact':
        this.setupContactValidationRules();
        break;
      default:
        throw new Error(`Unsupported entity type: ${this.config.entityType}`);
    }
  }

  /**
   * Setup validation rules for Contact entity
   */
  private setupContactValidationRules(): void {
    // Email validation
    this.validationRules.set('email', {
      field: 'email',
      required: true,
      validator: (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      transformer: (value: string) => value.toLowerCase().trim(),
      errorMessage: 'Invalid email format',
    });

    // Name validation
    this.validationRules.set('name', {
      field: 'name',
      required: false,
      validator: (value: string) => value.length >= 1 && value.length <= 255,
      transformer: (value: string) => value.trim(),
      errorMessage: 'Name must be between 1 and 255 characters',
    });

    // Age validation
    this.validationRules.set('age', {
      field: 'age',
      required: false,
      validator: (value: string) => {
        const num = parseInt(value);
        return !isNaN(num) && num >= 1 && num <= 150;
      },
      transformer: (value: string) => parseInt(value),
      errorMessage: 'Age must be a number between 1 and 150',
    });
  }

  /**
   * Get entity schema for validation
   */
  private getEntitySchema(entityType: EntityType): z.ZodSchema {
    switch (entityType) {
      case 'contact':
        return contactCreateSchema;
      default:
        throw new Error(`No schema defined for entity type: ${entityType}`);
    }
  }

  /**
   * Get field mappings for entity type
   */
  private getFieldMappings(entityType: EntityType): Map<string, string> {
    const mappings = new Map<string, string>();

    switch (entityType) {
      case 'contact':
        mappings.set('email', 'email');
        mappings.set('name', 'name');
        mappings.set('full_name', 'name');
        mappings.set('first_name', 'name'); // Could be enhanced to combine first+last
        mappings.set('age', 'age');
        break;
    }

    return mappings;
  }

  /**
   * Get required fields for entity type
   */
  private getRequiredFields(entityType: EntityType): string[] {
    switch (entityType) {
      case 'contact':
        return ['id'];
      default:
        return [];
    }
  }

  /**
   * Get field constraints
   */
  private getFieldConstraints(field: string): { minLength?: number; maxLength?: number } {
    const constraints: Record<string, { minLength?: number; maxLength?: number }> = {
      email: { maxLength: 255 },
      name: { maxLength: 255 },
    };

    return constraints[field] || {};
  }

  /**
   * Get validation error code for field
   */
  private getValidationErrorCode(field: string): ValidationErrorCode {
    const errorCodes: Record<string, ValidationErrorCode> = {
      email: ValidationErrorCode.INVALID_EMAIL_FORMAT,
      age: ValidationErrorCode.INVALID_AGE_RANGE,
    };

    return errorCodes[field] || ValidationErrorCode.DATA_TYPE_MISMATCH;
  }

  /**
   * Update validation statistics
   */
  private updateStats(result: ValidationResult): void {
    this.stats.totalRows++;

    if (result.isValid) {
      this.stats.validRows++;
    } else {
      this.stats.invalidRows++;
    }

    this.stats.totalErrors += result.errors.length;
    this.stats.totalWarnings += result.warnings.length;

    // Update error breakdown
    for (const error of result.errors) {
      this.stats.errorBreakdown[error.code] = (this.stats.errorBreakdown[error.code] || 0) + 1;
      this.stats.fieldErrors[error.field] = (this.stats.fieldErrors[error.field] || 0) + 1;
    }
  }

  /**
   * Initialize validation statistics
   */
  private initializeStats(): ValidationStats {
    return {
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      totalErrors: 0,
      totalWarnings: 0,
      errorBreakdown: {} as Record<ValidationErrorCode, number>,
      fieldErrors: {},
      processingTime: 0,
    };
  }
}

// Export default business rules for Contact entity
export const defaultContactBusinessRules: BusinessRule[] = [
  {
    name: 'email_uniqueness_within_batch',
    description: 'Email addresses should be unique within the same batch',
    validator: (data: Record<string, unknown>) => {
      // This would be implemented with a Set to track emails within batch
      return true; // Placeholder - actual implementation in deduplication engine
    },
    errorMessage: 'Duplicate email address found in batch',
    fields: ['email'],
  },
  {
    name: 'age_with_name_consistency',
    description: 'If age is provided, name should also be provided',
    validator: (data: Record<string, unknown>) => {
      const age = data.age;
      const name = data.name;

      if (age && age !== '' && (!name || name === '')) {
        return false;
      }
      return true;
    },
    errorMessage: 'Name is required when age is provided',
    fields: ['age', 'name'],
  },
];

// Export utility functions
export const ValidationUtils = {
  /**
   * Create validation config for entity type
   */
  createValidationConfig(entityType: EntityType, strict: boolean = false): ValidationConfig {
    return {
      entityType,
      strictMode: strict,
      allowExtraFields: !strict,
      transformData: true,
      maxErrorsPerRow: strict ? 1 : 10,
      businessRules: entityType === 'contact' ? defaultContactBusinessRules : [],
    };
  },

  /**
   * Format validation errors for user display
   */
  formatErrorsForDisplay(errors: ValidationError[]): string[] {
    return errors.map(
      error => `${error.name}: ${error.message} (got: "${error.stack?.substring(0, 50)}")`
    );
  },

  /**
   * Get error summary statistics
   */
  getErrorSummary(errors: ValidationError[]): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const error of errors) {
      summary[error.name] = (summary[error.message] || 0) + 1;
    }
    return summary;
  },
};
