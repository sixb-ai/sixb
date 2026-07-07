import { listObjectsInfiniteOptions } from "@sixb/client/hooks"
import { isFileRef } from "@sixb/core/blob-storage"
import {
  Combobox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sixb/ui/components"
import { useInfiniteQuery } from "@tanstack/react-query"
import {
  FileRefUploadField,
  parseFileRefFormValue,
  stringifyFileRefFormValue,
} from "../../../components/FileRefUploadField"
import { SchemaChip } from "./nodes/SchemaShape"

export type WorkflowInputFormValues = Record<string, string>
export type WorkflowInputFormErrors = Record<string, string>

const objectRefPageSize = 50
const keySeparator = "\u001f"

type FieldSpec = {
  readonly schema: unknown
  readonly required: boolean
  readonly nullable: boolean
  readonly description?: string
}

export function WorkflowRunInputFields({
  fields,
  values,
  errors,
  onChange,
  onFileUploadPendingChange,
  emptyLabel = "This workflow does not require any input.",
}: {
  fields: Readonly<Record<string, unknown>>
  values: WorkflowInputFormValues
  errors: WorkflowInputFormErrors
  onChange: (path: readonly string[], value: string) => void
  onFileUploadPendingChange?: (key: string, pending: boolean) => void
  emptyLabel?: string
}) {
  const entries = Object.entries(fields)
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-4">
      {entries.map(([name, descriptor]) => (
        <WorkflowInputField
          key={name}
          name={name}
          path={[name]}
          descriptor={descriptor}
          defaultRequired={true}
          values={values}
          errors={errors}
          onChange={onChange}
          onFileUploadPendingChange={onFileUploadPendingChange}
        />
      ))}
    </div>
  )
}

export function createInitialWorkflowInputFormValues(
  fields: Readonly<Record<string, unknown>>,
  initialValue: Readonly<Record<string, unknown>> = {}
): WorkflowInputFormValues {
  const values: WorkflowInputFormValues = {}
  for (const [name, descriptor] of Object.entries(fields)) {
    collectInitialFormValues(
      unwrapFieldDescriptor(descriptor, true),
      [name],
      values,
      initialValue[name]
    )
  }
  return values
}

export function buildWorkflowInput(
  fields: Readonly<Record<string, unknown>>,
  values: WorkflowInputFormValues
) {
  const input: Record<string, unknown> = {}
  const errors: WorkflowInputFormErrors = {}

  for (const [name, descriptor] of Object.entries(fields)) {
    const spec = unwrapFieldDescriptor(descriptor, true)
    const parsed = parseFieldValue({ spec, path: [name], values, errors })
    if (parsed.present) {
      input[name] = parsed.value
    }
  }

  return { input, errors }
}

function WorkflowInputField({
  name,
  path,
  descriptor,
  defaultRequired,
  values,
  errors,
  onChange,
  onFileUploadPendingChange,
}: {
  name: string
  path: readonly string[]
  descriptor: unknown
  defaultRequired: boolean
  values: WorkflowInputFormValues
  errors: WorkflowInputFormErrors
  onChange: (path: readonly string[], value: string) => void
  onFileUploadPendingChange?: (key: string, pending: boolean) => void
}) {
  const spec = unwrapFieldDescriptor(descriptor, defaultRequired)
  const key = pathKey(path)
  const controlId = fieldControlId(path)
  const error = errors[key]
  const schema = resolveRenderableSchema(spec.schema)

  if (isObjectSchema(schema)) {
    const entries = Object.entries(schema.properties)
    return (
      <fieldset className="min-w-0 rounded-lg border border-border bg-muted/20 p-4">
        <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
          <legend className="font-medium text-foreground">{name}</legend>
          <SchemaChip schema={spec.schema} />
          {spec.required ? <RequiredPill /> : <OptionalPill />}
        </div>
        {spec.description ? (
          <p className="mb-3 text-sm text-muted-foreground">{spec.description}</p>
        ) : null}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No fields</p>
        ) : (
          <div className="min-w-0 space-y-4">
            {entries.map(([fieldName, fieldDescriptor]) => (
              <WorkflowInputField
                key={fieldName}
                name={fieldName}
                path={[...path, fieldName]}
                descriptor={fieldDescriptor}
                defaultRequired={false}
                values={values}
                errors={errors}
                onChange={onChange}
                onFileUploadPendingChange={onFileUploadPendingChange}
              />
            ))}
          </div>
        )}
        {error ? <FieldError id={`${controlId}-error`} message={error} /> : null}
      </fieldset>
    )
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Label htmlFor={controlId} className="font-medium text-foreground">
          {name}
        </Label>
        <SchemaChip schema={spec.schema} />
        {spec.required ? <RequiredPill /> : <OptionalPill />}
      </div>
      {spec.description ? (
        <p className="text-sm text-muted-foreground">{spec.description}</p>
      ) : null}
      <WorkflowInputControl
        id={controlId}
        path={path}
        spec={spec}
        value={values[key] ?? ""}
        errorId={error ? `${controlId}-error` : undefined}
        onChange={onChange}
        onFileUploadPendingChange={onFileUploadPendingChange}
      />
      {error ? <FieldError id={`${controlId}-error`} message={error} /> : null}
    </div>
  )
}

function WorkflowInputControl({
  id,
  path,
  spec,
  value,
  errorId,
  onChange,
  onFileUploadPendingChange,
}: {
  id: string
  path: readonly string[]
  spec: FieldSpec
  value: string
  errorId?: string
  onChange: (path: readonly string[], value: string) => void
  onFileUploadPendingChange?: (key: string, pending: boolean) => void
}) {
  const schema = resolveRenderableSchema(spec.schema)

  if (isObjectRefSchema(schema)) {
    return (
      <ObjectRefInput
        path={path}
        objectTypeId={schema.objectTypeId}
        value={value}
        errorId={errorId}
        onChange={onChange}
      />
    )
  }

  if (isEnumSchema(schema)) {
    return (
      <EnumInput schema={schema} path={path} value={value} errorId={errorId} onChange={onChange} />
    )
  }

  if (schema === "boolean") {
    return <BooleanInput path={path} value={value} errorId={errorId} onChange={onChange} />
  }

  if (schema === "fileRef") {
    return (
      <FileRefUploadField
        id={id}
        value={parseFileRefFormValue(value)}
        onChange={(fileRef) => onChange(path, fileRef ? stringifyFileRefFormValue(fileRef) : "")}
        errorId={errorId}
        logicalPathPrefix={`workflow-input/${path.join("/")}`}
        onPendingChange={(pending) => onFileUploadPendingChange?.(pathKey(path), pending)}
      />
    )
  }

  if (isPrimitiveSchema(schema) && schema !== "fileRef") {
    return (
      <PrimitiveInput
        id={id}
        schema={schema}
        path={path}
        value={value}
        errorId={errorId}
        onChange={onChange}
      />
    )
  }

  return (
    <JsonFieldInput
      id={id}
      path={path}
      schema={schema}
      value={value}
      errorId={errorId}
      onChange={onChange}
    />
  )
}

function ObjectRefInput({
  path,
  objectTypeId,
  value,
  errorId,
  onChange,
}: {
  path: readonly string[]
  objectTypeId: string
  value: string
  errorId?: string
  onChange: (path: readonly string[], value: string) => void
}) {
  const objectsQuery = useInfiniteQuery(
    listObjectsInfiniteOptions({
      query: {
        objectTypeId,
        limit: String(objectRefPageSize),
        orderBy: "updatedAt",
        order: "desc",
      },
    })
  )
  const objects = objectsQuery.data?.pages.flatMap((page) => page.objects) ?? []
  const disabled = objectsQuery.isLoading || objects.length === 0

  return (
    <div className="w-full min-w-0 space-y-2">
      <Combobox
        value={value}
        disabled={disabled}
        aria-describedby={errorId}
        hasMore={objectsQuery.hasNextPage}
        loadingMore={objectsQuery.isFetchingNextPage}
        loadingLabel="Loading more objects..."
        onLoadMore={() => void objectsQuery.fetchNextPage()}
        options={objects.map((object) => ({
          value: object.primaryId,
          label: object.name || object.primaryId,
          description: object.primaryId,
        }))}
        onValueChange={(next) => onChange(path, next)}
        placeholder={
          objectsQuery.isLoading ? `Loading ${objectTypeId} objects...` : `Select a ${objectTypeId}`
        }
        searchPlaceholder={`Search ${objectTypeId} objects...`}
        emptyLabel={`No ${objectTypeId} objects found.`}
        className="bg-background"
      />
      {!objectsQuery.isLoading && objects.length === 0 ? (
        <p className="text-xs text-muted-foreground">No {objectTypeId} objects are available.</p>
      ) : null}
    </div>
  )
}

function EnumInput({
  schema,
  path,
  value,
  errorId,
  onChange,
}: {
  schema: EnumSchema
  path: readonly string[]
  value: string
  errorId?: string
  onChange: (path: readonly string[], value: string) => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(path, next)}>
      <SelectTrigger aria-describedby={errorId} className="w-full min-w-0 bg-background">
        <SelectValue placeholder="Choose a value" />
      </SelectTrigger>
      <SelectContent>
        {schema.values.map((option) => (
          <SelectItem key={String(option)} value={String(option)}>
            {String(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function BooleanInput({
  path,
  value,
  errorId,
  onChange,
}: {
  path: readonly string[]
  value: string
  errorId?: string
  onChange: (path: readonly string[], value: string) => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(path, next)}>
      <SelectTrigger aria-describedby={errorId} className="w-full min-w-0 bg-background">
        <SelectValue placeholder="Choose true or false" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="true">True</SelectItem>
        <SelectItem value="false">False</SelectItem>
      </SelectContent>
    </Select>
  )
}

function PrimitiveInput({
  id,
  schema,
  path,
  value,
  errorId,
  onChange,
}: {
  id: string
  schema: PrimitiveSchema
  path: readonly string[]
  value: string
  errorId?: string
  onChange: (path: readonly string[], value: string) => void
}) {
  return (
    <Input
      id={id}
      type={inputTypeForPrimitive(schema)}
      step={
        schema === "integer" ? "1" : schema === "double" || schema === "decimal" ? "any" : undefined
      }
      value={value}
      onChange={(event) => onChange(path, event.target.value)}
      placeholder={placeholderForPrimitive(schema)}
      aria-describedby={errorId}
      className="bg-background"
    />
  )
}

function JsonFieldInput({
  id,
  path,
  schema,
  value,
  errorId,
  onChange,
}: {
  id: string
  path: readonly string[]
  schema: unknown
  value: string
  errorId?: string
  onChange: (path: readonly string[], value: string) => void
}) {
  return (
    <div className="w-full min-w-0 space-y-2">
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(path, event.target.value)}
        placeholder={defaultJsonForSchema(schema) || "{ ... }"}
        spellCheck={false}
        aria-describedby={errorId}
        className="min-h-24 w-full min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <p className="text-xs text-muted-foreground">
        This field uses a structured value. Enter only this field as JSON.
      </p>
    </div>
  )
}

function RequiredPill() {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      Required
    </span>
  )
}

function OptionalPill() {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      Optional
    </span>
  )
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  )
}

function collectInitialFormValues(
  spec: FieldSpec,
  path: readonly string[],
  values: WorkflowInputFormValues,
  initialValue: unknown
): void {
  const schema = resolveRenderableSchema(spec.schema)
  const initialFormValue = initialFormValueForSchema(schema, initialValue)
  if (initialFormValue !== null) {
    values[pathKey(path)] = initialFormValue
  }

  const defaultJson = defaultJsonForSchema(schema)
  if (initialFormValue === null && spec.required && defaultJson) {
    values[pathKey(path)] = defaultJson
  }

  if (isObjectSchema(schema)) {
    const initialObject = isRecord(initialValue) ? initialValue : {}
    for (const [fieldName, fieldDescriptor] of Object.entries(schema.properties)) {
      collectInitialFormValues(
        unwrapFieldDescriptor(fieldDescriptor, false),
        [...path, fieldName],
        values,
        initialObject[fieldName]
      )
    }
  }
}

function parseFieldValue({
  spec,
  path,
  values,
  errors,
}: {
  spec: FieldSpec
  path: readonly string[]
  values: WorkflowInputFormValues
  errors: WorkflowInputFormErrors
}): { present: boolean; value?: unknown } {
  const schema = resolveRenderableSchema(spec.schema)
  const key = pathKey(path)
  const raw = values[key]
  const trimmed = raw?.trim() ?? ""

  if (isValueTypeRefSchema(schema) && !schema._resolved) {
    return parseJsonField({ spec, path, values, errors })
  }

  if (isObjectRefSchema(schema)) {
    if (!trimmed) return missingField(spec, path, errors)
    return { present: true, value: { objectTypeId: schema.objectTypeId, primaryId: trimmed } }
  }

  if (isEnumSchema(schema)) {
    if (!trimmed) return missingField(spec, path, errors)
    const option = schema.values.find((candidate) => String(candidate) === trimmed)
    if (option === undefined) {
      errors[key] = `${fieldLabel(path)} must be one of the available values.`
      return { present: false }
    }
    return { present: true, value: option }
  }

  if (schema === "boolean") {
    if (trimmed !== "true" && trimmed !== "false") return missingField(spec, path, errors)
    return { present: true, value: trimmed === "true" }
  }

  if (schema === "fileRef") {
    if (!trimmed) return missingField(spec, path, errors)

    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!isFileRef(parsed)) {
        errors[key] = `${fieldLabel(path)} must be an uploaded file.`
        return { present: false }
      }
      return { present: true, value: parsed }
    } catch {
      errors[key] = `${fieldLabel(path)} must be an uploaded file.`
      return { present: false }
    }
  }

  if (isPrimitiveSchema(schema) && schema !== "fileRef") {
    if (!trimmed) return missingField(spec, path, errors)

    if (schema === "integer") {
      const parsed = Number(trimmed)
      if (!Number.isInteger(parsed)) {
        errors[key] = `${fieldLabel(path)} must be an integer.`
        return { present: false }
      }
      return { present: true, value: parsed }
    }

    if (schema === "double" || schema === "decimal") {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) {
        errors[key] = `${fieldLabel(path)} must be numeric.`
        return { present: false }
      }
      return { present: true, value: parsed }
    }

    if (schema === "timestamp") {
      const timestamp = new Date(trimmed)
      if (Number.isNaN(timestamp.getTime())) {
        errors[key] = `${fieldLabel(path)} must be a valid timestamp.`
        return { present: false }
      }
      return { present: true, value: timestamp.toISOString() }
    }

    return { present: true, value: trimmed }
  }

  if (isObjectSchema(schema)) {
    if (!spec.required && !hasAnyValueForPath(values, path)) {
      return { present: false }
    }

    const objectValue: Record<string, unknown> = {}
    let present = false

    for (const [fieldName, fieldDescriptor] of Object.entries(schema.properties)) {
      const fieldSpec = unwrapFieldDescriptor(fieldDescriptor, false)
      const parsed = parseFieldValue({
        spec: fieldSpec,
        path: [...path, fieldName],
        values,
        errors,
      })
      if (parsed.present) {
        objectValue[fieldName] = parsed.value
        present = true
      }
    }

    if (present || spec.required) return { present: true, value: objectValue }
    return { present: false }
  }

  return parseJsonField({ spec, path, values, errors })
}

function parseJsonField({
  spec,
  path,
  values,
  errors,
}: {
  spec: FieldSpec
  path: readonly string[]
  values: WorkflowInputFormValues
  errors: WorkflowInputFormErrors
}) {
  const key = pathKey(path)
  const raw = values[key]?.trim() ?? ""
  if (!raw) return missingField(spec, path, errors)

  try {
    return { present: true, value: JSON.parse(raw) }
  } catch (error) {
    errors[key] = error instanceof Error ? error.message : `${fieldLabel(path)} must be valid JSON.`
    return { present: false }
  }
}

function missingField(spec: FieldSpec, path: readonly string[], errors: WorkflowInputFormErrors) {
  if (spec.nullable) return { present: true, value: null }
  if (!spec.required) return { present: false }
  errors[pathKey(path)] = `${fieldLabel(path)} is required.`
  return { present: false }
}

function hasAnyValueForPath(values: WorkflowInputFormValues, path: readonly string[]): boolean {
  const prefix = `${pathKey(path)}${keySeparator}`
  for (const [key, value] of Object.entries(values)) {
    if ((key === pathKey(path) || key.startsWith(prefix)) && value.trim()) {
      return true
    }
  }
  return false
}

function unwrapFieldDescriptor(value: unknown, defaultRequired: boolean): FieldSpec {
  if (isRecord(value) && "schema" in value) {
    return {
      schema: value.schema,
      required: typeof value.required === "boolean" ? value.required : defaultRequired,
      nullable: value.nullable === true,
      description: typeof value.description === "string" ? value.description : undefined,
    }
  }

  return {
    schema: value,
    required: defaultRequired,
    nullable: false,
  }
}

function resolveRenderableSchema(schema: unknown): unknown {
  if (isValueTypeRefSchema(schema) && schema._resolved) {
    return schema._resolved
  }
  return schema
}

function defaultJsonForSchema(schema: unknown): string {
  if (isArraySchema(schema)) return "[]"
  if (isMapSchema(schema)) return "{}"
  return ""
}

function initialFormValueForSchema(schema: unknown, value: unknown): string | null {
  if (value === undefined || value === null || isObjectSchema(schema)) return null

  if (isObjectRefSchema(schema)) {
    if (typeof value === "string") return value
    if (isRecord(value) && typeof value.primaryId === "string") return value.primaryId
    return null
  }

  if (isEnumSchema(schema)) {
    const matchingOption = schema.values.find((option) => String(option) === String(value))
    return matchingOption === undefined ? null : String(matchingOption)
  }

  if (schema === "boolean") {
    return typeof value === "boolean" ? String(value) : null
  }

  if (schema === "fileRef") {
    return isFileRef(value) ? JSON.stringify(value) : null
  }

  if (schema === "date" && typeof value === "string") {
    return value.slice(0, 10)
  }

  if (schema === "timestamp" && typeof value === "string") {
    return timestampInputValue(value)
  }

  if (isPrimitiveSchema(schema) && schema !== "fileRef") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value)
    }
    return null
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return null
  }
}

function timestampInputValue(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  // datetime-local inputs expect wall-clock time, so preserve the instant by displaying local time.
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function inputTypeForPrimitive(schema: PrimitiveSchema): string {
  if (schema === "integer" || schema === "double" || schema === "decimal") return "number"
  if (schema === "date") return "date"
  if (schema === "timestamp") return "datetime-local"
  return "text"
}

function placeholderForPrimitive(schema: PrimitiveSchema): string {
  if (schema === "uuid") return "00000000-0000-0000-0000-000000000000"
  if (schema === "date") return "YYYY-MM-DD"
  if (schema === "timestamp") return "YYYY-MM-DDTHH:mm"
  if (schema === "integer" || schema === "double" || schema === "decimal") return "0"
  return "Enter a value"
}

export function workflowInputPathKey(path: readonly string[]): string {
  return path.join(keySeparator)
}

function pathKey(path: readonly string[]): string {
  return workflowInputPathKey(path)
}

function fieldLabel(path: readonly string[]): string {
  return path.join(".")
}

function fieldControlId(path: readonly string[]): string {
  return `workflow-input-${path.map((part) => part.replace(/[^a-zA-Z0-9_-]/g, "-")).join("-")}`
}

type PrimitiveSchema =
  | "string"
  | "integer"
  | "double"
  | "decimal"
  | "boolean"
  | "date"
  | "timestamp"
  | "uuid"
  | "fileRef"

type EnumSchema = {
  readonly type: "enum"
  readonly valueType: "string" | "integer"
  readonly values: readonly (string | number)[]
}

type ObjectRefSchema = {
  readonly type: "objectRef"
  readonly objectTypeId: string
}

type ObjectSchema = {
  readonly type: "object"
  readonly properties: Readonly<Record<string, unknown>>
}

type ValueTypeRefSchema = {
  readonly type: "valueTypeRef"
  readonly valueTypeId: string
  readonly _resolved?: unknown
}

type ArraySchema = {
  readonly type: "array"
  readonly items: unknown
}

type MapSchema = {
  readonly type: "map"
  readonly valueSchema: unknown
}

function isPrimitiveSchema(value: unknown): value is PrimitiveSchema {
  return (
    value === "string" ||
    value === "integer" ||
    value === "double" ||
    value === "decimal" ||
    value === "boolean" ||
    value === "date" ||
    value === "timestamp" ||
    value === "uuid" ||
    value === "fileRef"
  )
}

function isObjectRefSchema(value: unknown): value is ObjectRefSchema {
  return isRecord(value) && value.type === "objectRef" && typeof value.objectTypeId === "string"
}

function isEnumSchema(value: unknown): value is EnumSchema {
  return (
    isRecord(value) &&
    value.type === "enum" &&
    (value.valueType === "string" || value.valueType === "integer") &&
    Array.isArray(value.values)
  )
}

function isObjectSchema(value: unknown): value is ObjectSchema {
  return isRecord(value) && value.type === "object" && isRecord(value.properties)
}

function isValueTypeRefSchema(value: unknown): value is ValueTypeRefSchema {
  return isRecord(value) && value.type === "valueTypeRef" && typeof value.valueTypeId === "string"
}

function isArraySchema(value: unknown): value is ArraySchema {
  return isRecord(value) && value.type === "array"
}

function isMapSchema(value: unknown): value is MapSchema {
  return isRecord(value) && value.type === "map"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
