import { Fragment } from "react";
import { describe, expect, it } from "vitest";
import { parseSelectOptions } from "../select";

describe("parseSelectOptions", () => {
  it("parses plain options with explicit values and text labels", () => {
    const result = parseSelectOptions(
      <>
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </>
    );
    expect(result).toEqual([
      { value: "a", label: "Alpha", disabled: false },
      { value: "b", label: "Beta", disabled: false },
    ]);
  });

  it("falls back to text content when value is omitted (native semantics)", () => {
    const result = parseSelectOptions(<option>Gamma</option>);
    expect(result).toEqual([{ value: "Gamma", label: "Gamma", disabled: false }]);
  });

  it("coerces numeric values to strings", () => {
    const result = parseSelectOptions(<option value={7}>Seven</option>);
    expect(result).toEqual([{ value: "7", label: "Seven", disabled: false }]);
  });

  it("preserves an explicit empty-string value", () => {
    const result = parseSelectOptions(<option value="">All</option>);
    expect(result).toEqual([{ value: "", label: "All", disabled: false }]);
  });

  it("captures the disabled attribute", () => {
    const result = parseSelectOptions(<option value="x" disabled>Nope</option>);
    expect(result[0].disabled).toBe(true);
  });

  it("flattens arrays produced by .map()", () => {
    const items = [
      { id: "1", name: "One" },
      { id: "2", name: "Two" },
    ];
    const result = parseSelectOptions(
      items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))
    );
    expect(result.map((o) => o.value)).toEqual(["1", "2"]);
  });

  it("flattens nested fragments and mixed children", () => {
    const result = parseSelectOptions(
      <>
        <option value="head">Head</option>
        <Fragment>
          <option value="nested">Nested</option>
        </Fragment>
      </>
    );
    expect(result.map((o) => o.value)).toEqual(["head", "nested"]);
  });

  it("assembles labels from interpolated fragments", () => {
    const count = 3;
    const result = parseSelectOptions(<option value="c">Count {count}</option>);
    expect(result[0].label).toBe("Count 3");
  });

  it("ignores nullish and boolean children", () => {
    const show = false;
    const result = parseSelectOptions(
      <>
        {null}
        {show && <option value="hidden">Hidden</option>}
        <option value="v">Visible</option>
      </>
    );
    expect(result.map((o) => o.value)).toEqual(["v"]);
  });
});
