# Patches

Documentation for Q3 IDE patches applied on top of VS Code.

---

## fix-policies

**Replace `@vscode/policy-watcher` with `@q3ide/policy-watcher`**

VS Code uses `@vscode/policy-watcher` to enforce Group Policy Objects (GPOs) on
Windows. That package reads from:

```
HKLM\SOFTWARE\Policies\Microsoft\<productName>
```

Q3 IDE forks this into `@q3ide/policy-watcher`, which takes a separate
`vendorName` argument. The `createWatcher()` call becomes:

```ts
createWatcher('Q3 IDE', this.productName, ...)
```

Because Q3 IDE sets `product.nameLong = 'Q3 IDE'` (via `prepare_vscode.sh`),
`this.productName` resolves to `'Q3 IDE'` at runtime. Therefore, the final
Windows registry key that Q3 IDE reads policies from is:

```
HKLM\SOFTWARE\Policies\Q3 IDE\Q3 IDE\<PolicyName>
```

(or `HKCU\SOFTWARE\Policies\Q3 IDE\Q3 IDE\<PolicyName>` for per-user policies)

This differs from VS Code's path (`Microsoft\VSCode`) and is the root cause of
[issue #2714](https://github.com/yeekcay/Q3-ide/issues/2714) where users mirror
VS Code's registry structure and find their GPOs ignored. Enterprise admins must
use the Q3 IDE-specific registry path.

### References

- [Q3 IDE issue #2714](https://github.com/yeekcay/Q3-ide/issues/2714)
- [Q3 IDE/policy-watcher — RegistryPolicy.hh](https://github.com/Q3 IDE/policy-watcher/blob/main/src/windows/RegistryPolicy.hh)
