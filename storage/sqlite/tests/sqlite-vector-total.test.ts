import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { compileObjectQuery } from "../src/objects/query-compiler"

test("vector totals count compatible candidates up to k without evaluating distances", () => {
  const db = new Database(":memory:")
  try {
    db.run(
      "CREATE TABLE objects(project_id TEXT, object_type_id TEXT, primary_id TEXT, properties TEXT DEFAULT (json_object()), created_at TEXT, updated_at TEXT, version INTEGER, last_commit_id TEXT)"
    )
    db.run(
      "CREATE TABLE object_vectors(project_id TEXT, object_type_id TEXT, primary_id TEXT, profile TEXT, configuration TEXT, embedding BLOB)"
    )
    db.run(
      "INSERT INTO objects(project_id,object_type_id,primary_id) VALUES ('p','Product','a'),('p','Product','b'),('p','Product','c')"
    )
    db.run(
      "INSERT INTO object_vectors VALUES ('p','Product','a','content','current',x'0000803f00000000'),('p','Product','b','content','current',x'0000803f00000000'),('p','Product','c','content','old',x'0000803f00000000')"
    )
    // Regression proof: restore totalSql to COUNT(ranked SQL). No vector extension is loaded,
    // so attempting to evaluate the distance function must fail.
    for (const [k, expected] of [
      [1, 1],
      [5, 2],
    ]) {
      const compiled = compileObjectQuery("p", {
        kind: "vector",
        input: { kind: "start", objectTypeId: "Product" },
        profile: "content",
        configuration: "current",
        vector: [1, 0],
        k: k!,
      })
      expect(db.query(compiled.totalSql).get(...compiled.totalArgs)).toEqual({ total: expected })
    }
  } finally {
    db.close()
  }
})
