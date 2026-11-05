import type {
  FleetioEqFilter,
  FleetioLikeOrEqFilter,
  FleetioRangeFilter,
  FleetioSortDirection,
} from "./common"
import type { FleetioAttachmentPermissions, FleetioImage } from "./shared"

export interface FleetioContactUser {
  readonly id?: number | null
  /** The email address associated with this `User`. */
  readonly email?: string | null
  /** The username of this `User`. */
  readonly username?: string | null
  /** The timezone set for this `User`. */
  readonly time_zone?: string | null
  /** This `User`'s type. */
  readonly user_type?: "admin" | "regular" | "owner" | null
  /** The date and time at which the User was archived (deactivated). */
  readonly archived_at?: string | null
  /** Basic information about this `User`'s `Role`, if applicable. */
  readonly role?: { readonly id?: number | null; readonly name?: string | null }
  readonly vehicles_record_set?: { readonly id?: number | null; readonly name?: string | null }
  readonly equipments_record_set?: { readonly id?: number | null; readonly name?: string | null }
  readonly contacts_record_set?: { readonly id?: number | null; readonly name?: string | null }
  readonly parts_record_set?: { readonly id?: number | null; readonly name?: string | null }
  readonly inspection_forms_record_set?: {
    readonly id?: number | null
    readonly name?: string | null
  }
}

/** A Contact */
export interface FleetioContact {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The Contact's full name. */
  readonly name: string | null
  /** The Contact's first name. */
  readonly first_name: string | null
  /** The Contact's middle name. */
  readonly middle_name: string | null
  /** If this Contact belongs to a Group, this will be the Fleetio ID of that Group. */
  readonly group_id: number | null
  /** If this Contact belongs to a Group, this will be the Group's name. */
  readonly group_name: string | null
  /** The Contact's last name. */
  readonly last_name: string | null
  /** The number of images associated with this Contact. */
  readonly images_count: number
  /** The number of documents associated with this Contact. */
  readonly documents_count: number
  /** The number of `Comments` associated with this Contact. */
  readonly comments_count: number
  /** The Contact's email address. */
  readonly email?: string | null
  /** Whether this Contact is a Technician. */
  readonly technician?: boolean | null
  /** Whether this Contact is a Vehicle Operator. */
  readonly vehicle_operator?: boolean | null
  /** Whether this Contact is an Employee. */
  readonly employee?: boolean | null
  /** The Contact's birth date. */
  readonly birth_date?: string | null
  /** The Contact's street address. */
  readonly street_address?: string | null
  /** The second line of the Contact's street address. */
  readonly street_address_line_2?: string | null
  /** The Contact's city. */
  readonly city?: string | null
  /** The Contact's region. */
  readonly region?: string | null
  /** The Contact's postal code. */
  readonly postal_code?: string | null
  /** The Contact's country. */
  readonly country?: string | null
  /** The Contact's employee number. */
  readonly employee_number?: string | null
  /** The Contact's job title. */
  readonly job_title?: string | null
  /** The Contact's license class. */
  readonly license_class?: string | null
  /** The Contact's license number. */
  readonly license_number?: string | null
  /** The state which issued the Contact's license. */
  readonly license_state?: string | null
  /** The Contact's driver's license expiration date. */
  readonly license_expiration?: string | null
  /** The Contact's home phone number. */
  readonly home_phone_number?: string | null
  /** The Contact's mobile phone number. */
  readonly mobile_phone_number?: string | null
  /** The Contact's work phone number. */
  readonly work_phone_number?: string | null
  /** Any other mobile phone number belonging to this Contact. */
  readonly other_phone_number?: string | null
  /** The Contact's start date. */
  readonly start_date?: string | null
  /** The Contact's leave date. */
  readonly leave_date?: string | null
  /** The Contact's hourly rate. */
  readonly hourly_labor_rate?: number | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** The URL pointing to the default image for this Contact. */
  readonly default_image_url: string | null
  readonly account_membership_id?: number | null
  /** The date and time at which this Contact was archived, if applicable. */
  readonly archived_at?: string | null
  readonly user: FleetioContactUser | null
  readonly last_api_request?: string | null
  readonly last_web_access?: string | null
  readonly last_mobile_app_access?: string | null
}

/** A Contact */
export interface FleetioContactSummary {
  /** The number of documents associated with this Contact. */
  readonly documents_count: number
  /** The number of comments associated with this Contact. */
  readonly comments_count: number
  readonly id?: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The Contact's email address. */
  readonly email?: string | null
  /** The Contact's full name. */
  readonly name: string | null
  /** The Contact's first name. */
  readonly first_name: string | null
  /** The Contact's middle name. */
  readonly middle_name: string | null
  /** The Contact's last name. */
  readonly last_name: string | null
  /** If this Contact belongs to a Group, this will be the Fleetio ID of that `Group`. */
  readonly group_id: number | null
  /** If this Contact belongs to a Group, this will be the `Group`'s name. */
  readonly group_name: string | null
  /** If this Contact belongs to a Group, this will be a pipe delimited string representing the `Group` hierarchy. */
  readonly group_hierarchy?: string | null
  /** Whether or not the Contact is a Technician. */
  readonly technician?: boolean | null
  /** Whether or not the Contact is a Vehicle Operator. */
  readonly vehicle_operator?: boolean | null
  /** Whether or not the Contact is an Employee. */
  readonly employee?: boolean | null
  /** The Contact's birth date. */
  readonly birth_date?: string | null
  /** The Contact's street address. */
  readonly street_address?: string | null
  /** The Contact's street address line 2. */
  readonly street_address_line_2?: string | null
  /** The Contact's city. */
  readonly city?: string | null
  /** The Contact's region, state, or province. */
  readonly region?: string | null
  /** The Contact's postal code, zip code, or equivalent. */
  readonly postal_code?: string | null
  /** The Contact's country. */
  readonly country?: string | null
  /** The Contact's employee number. */
  readonly employee_number?: string | null
  /** The Contact's job title. */
  readonly job_title?: string | null
  /** The Contact's driver's license class. */
  readonly license_class?: string | null
  /** The Contact's driver's license number. */
  readonly license_number?: string | null
  /** The locality which issued the Contact's license. */
  readonly license_state?: string | null
  /** The Contact's home phone number. */
  readonly home_phone_number?: string | null
  /** The Contact's mobile phone number. */
  readonly mobile_phone_number?: string | null
  /** The Contact's work phone number. */
  readonly work_phone_number?: string | null
  /** Any other phone number for this Contact. */
  readonly other_phone_number?: string | null
  /** When the Contact started working for the company, if applicable. */
  readonly start_date?: string | null
  /** When the Contact left or will leave the company, if applicable. */
  readonly leave_date?: string | null
  /** The Contact's hourly rate in cents. */
  readonly hourly_labor_rate_cents?: number | null
  readonly attachment_permissions?: FleetioAttachmentPermissions | null
  /** The URL of the Contact's default image/profile photo, if any. */
  readonly default_image_url: string | null
  readonly account_membership_id?: number | null
  /** The last date and time this Contact's associated User made an API request. */
  readonly last_api_request?: string | null
  /** The last date and time this Contact's associated User signed into the web application. */
  readonly last_web_access?: string | null
  /** The last date and time this Contact's associated User used the mobile app. */
  readonly last_mobile_app_access?: string | null
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  /** A list of the images attached to this record. */
  readonly images?: readonly FleetioImage[]
  /** The number of images attached to this record. */
  readonly images_count: number
  /** The Contacts' access configurations for the current account. */
  readonly account_membership?: {
    readonly id?: number
    readonly user_type?: "admin" | "owner" | "regular"
    readonly regular_user_role?: { readonly id?: number; readonly name?: string } | null
  } | null
}

export interface FleetioContactFilter {
  readonly email?: FleetioLikeOrEqFilter
  readonly last_name?: FleetioLikeOrEqFilter
  readonly group_id?: FleetioEqFilter
  readonly employee_number?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioContactSort {
  readonly group_id?: FleetioSortDirection
  readonly created_at?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}

export interface FleetioContactAdminRoleAttributes {
  /** The level of access for the administration section. */
  readonly administration_access?: "full" | "some" | "none"
  /** Whether this `User` can manage account settings. */
  readonly manage_account_settings?: boolean
  /** Whether this `User` can manage subscriptions belonging to the `Account`. */
  readonly manage_subscription?: boolean
  /** Whether this `User` can export account data. */
  readonly export_account_data?: boolean
  /** Whether this `User` can manage `Groups`. */
  readonly manage_groups?: boolean
  /** Whether this `User` can manage `Custom Records`. */
  readonly manage_custom_object_templates?: boolean
  /** Whether this `User` can manage `Automations`. */
  readonly manage_workflows?: boolean
  /** Whether this `User` can manage `Webhooks`. */
  readonly manage_webhooks?: boolean
  /** Whether this `User` can manage `Integrations`. */
  readonly manage_integrations?: boolean
  /** Whether this `User` can manage `Integration Links`. */
  readonly manage_integration_links?: boolean
  /** Whether this `User` can manage `SAML Connectors`. */
  readonly manage_saml_connectors?: boolean
  /** Whether this `User` can manage Security Settings. */
  readonly manage_security_settings?: boolean
  /** The level of access for the user management section. */
  readonly user_management_access?: "full" | "some" | "none"
  /** Whether this `User` can manage other `Users`. */
  readonly manage_users?: boolean
}

export interface FleetioContactAccountMembershipAttributes {
  /** Any role or record set attributes will be ignored if this is set to `admin`. */
  readonly user_type?: "admin" | "regular"
  /** The ID of the `Role` assigned to the `User`. */
  readonly role_id?: number
  /** The ID of the `Vehicles` record set the `User` has access to. */
  readonly vehicles_record_set_id?: number
  /** The ID of the `Contacts` record set the `User` has access to. */
  readonly contacts_record_set_id?: number
  /** The ID of the `Equipment` record set the `User` has access to. */
  readonly equipments_record_set_id?: number
  /** The ID of the `Inspection Forms` record set the `User` has access to. */
  readonly inspection_forms_record_set_id?: number
  /** The ID of the `Parts` record set the `User` has access to. */
  readonly parts_record_set_id?: number
  /** The name of the `Role` to be assigned to the `User`. */
  readonly role_name?: string
  /** The name of the `Vehicles` record set the `User` has access to. */
  readonly vehicles_record_set_name?: string
  /** The name of the `Contacts` record set the `User` has access to. */
  readonly contacts_record_set_name?: string
  /** The name of the `Equipment` record set the `User` has access to. */
  readonly equipments_record_set_name?: string
  /** The name of the `Inspection Forms` record set the `User` has access to. */
  readonly inspection_forms_record_set_name?: string
  /** The name of the `Parts` record set the `User` has access to. */
  readonly parts_record_set_name?: string
  /** Permissions for the `User` if the `user_type` is `admin`. */
  readonly admin_role_attributes?: FleetioContactAdminRoleAttributes
  readonly user_attributes?: {
    readonly email?: string
    readonly username?: string
    readonly password?: string
  }
}

export interface FleetioContactCreateInput {
  /** This Contact's first name. */
  readonly first_name: string
  /** This Contact's middle name. */
  readonly middle_name?: string
  /** This Contact's last name. */
  readonly last_name?: string
  /** This Contact's birth date. */
  readonly birth_date?: string
  /** If this Contact belongs to a Group, this will be a pipe delimited string representing the Group hierarchy. */
  readonly group_hierarchy?: string | null
  /** This Contact's email address. */
  readonly email?: string
  /** This Contact's mobile phone number. */
  readonly mobile_phone_number?: string
  /** This Contact's home phone number. */
  readonly home_phone_number?: string
  /** This Contact's work phone number. */
  readonly work_phone_number?: string
  /** Any other phone number for this Contact. */
  readonly other_phone_number?: string
  /** The street address of this Contact. */
  readonly street_address?: string
  /** The second line of this Contact's street address. */
  readonly street_address_line_2?: string
  /** The city of this Contact's address. */
  readonly city?: string
  /** The region, state, province, or territory of this Contact's address. */
  readonly region?: string
  /** The postal code for this Contact's address. */
  readonly postal_code?: string
  /** The country where this Contact resides. */
  readonly country?: string
  /** This Contact's employee number. */
  readonly employee_number?: string
  /** This Contact's job title. */
  readonly job_title?: string
  /** The date at which this Contact started, or is expected to start. */
  readonly start_date?: string
  /** The date at which this Contact left, or is expected to leave. */
  readonly leave_date?: string
  /** Whether this Contact is a Vehicle Operator. */
  readonly vehicle_operator?: boolean
  /** The license number of this Contact. */
  readonly license_number?: string
  /** The class of this Contact's license. */
  readonly license_class?: string
  /** The state, province, region, or territory of this Contact's license. */
  readonly license_state?: string
  /** The hourly labor rate for this Contact. */
  readonly hourly_labor_rate?: number
  /** *Full details on working with Custom Fields here. */
  readonly custom_fields?: Readonly<Record<string, unknown>> | null
  readonly group_id?: number
  /** The date and time at which this Contact's license expires. */
  readonly license_expiration?: string
  /** Whether this Contact is an Employee. */
  readonly employee?: boolean
  /** Whether this Contact is a Technician. */
  readonly technician?: boolean
  /** Whether this Contact has User Access. */
  readonly user_access?: boolean
  /** These attributes require an Organization Token or Partner Token to be present in the request. */
  readonly account_membership_attributes?: FleetioContactAccountMembershipAttributes
  readonly default_image_attributes?: { readonly file_url?: string; readonly default?: boolean }
}

export type FleetioContactUpdateInput = Partial<FleetioContactCreateInput>

export interface FleetioArchivedContactFilter {
  readonly email?: FleetioLikeOrEqFilter
  readonly last_name?: FleetioLikeOrEqFilter
  readonly group_id?: FleetioEqFilter
  readonly employee_number?: FleetioEqFilter
  readonly created_at?: FleetioRangeFilter
  readonly updated_at?: FleetioRangeFilter
}

export interface FleetioArchivedContactSort {
  readonly archived_at?: FleetioSortDirection
  readonly id?: FleetioSortDirection
}
