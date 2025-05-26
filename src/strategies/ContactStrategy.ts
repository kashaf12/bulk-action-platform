import { EntityStrategy } from '../interfaces/EntityStrategy';
import { Contact } from '../models/Contact';
import { ContactRepository } from '../repositories/ContactRepository';
import { IContact } from '../types/entities/contact';

export class ContactStrategy implements EntityStrategy<IContact> {
  private contactRepository: ContactRepository;

  constructor() {
    this.contactRepository = new ContactRepository();
  }

  mapRowToEntity(rowData: Record<string, string>): IContact {
    return {
      email: rowData.email?.trim()?.toLowerCase(),
      name: rowData.name?.trim(),
      age: rowData.age ? parseInt(rowData.age) : undefined,
      phone: rowData.phone?.trim(),
      company: rowData.company?.trim(),
      status: (rowData.status?.toLowerCase() as 'active' | 'inactive' | 'pending') || 'active',
    } as IContact;
  }

  getRepository(): ContactRepository {
    return this.contactRepository;
  }

  getRequiredFields(): string[] {
    return ['email'];
  }

  getUniqueIdentifierField(): string {
    return 'email';
  }
}
