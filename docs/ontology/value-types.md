# Value types

A value type is a named schema you can reuse across properties. Use one when values such as
addresses or coordinates should have the same shape wherever they appear.

## Define a value type

Export `defineValueType()` from `ontology/`. An address can describe the same fields on customers,
invoices, and other types:

```ts
// ontology/address.ts
import { defineValueType } from "@sixb/core/ontology"

export const Address = defineValueType({
  id: "Address",
  name: "Address",
  schema: {
    type: "object",
    properties: {
      street: { schema: "string", required: true },
      city: { schema: "string", required: true },
      postcode: { schema: "string" },
    },
  },
})
```

`id`, `name`, and `schema` are required. Add a `description` when it helps explain the value.
The schema can use any of the [property schema forms](properties.md#choose-a-schema).

## Use it in a property

Pass the imported definition to `valueTypeRef()`. This preserves the schema's TypeScript types
and lets Sixb validate each value against it:

```ts
// ontology/customer.ts
import { defineObjectType, prop, valueTypeRef } from "@sixb/core/ontology"
import { Address } from "./address"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("billingAddress", valueTypeRef(Address), { required: true }),
    prop("shippingAddress", valueTypeRef(Address)),
  ],
})
```

The property's `required` and `nullable` options control whether the whole address may be
omitted or null. The address schema controls the fields inside it.

A value type reuses a shape, not a shared record. Billing and shipping addresses hold independent
values. If several objects should refer to one address with its own identity, define an
[object type](object-types.md) and connect it with [links](links.md).
