import {
  Bell,
  Box,
  Calendar,
  CheckCircle2,
  Cog,
  Database,
  Filter,
  Folder,
  GitBranch,
  Home,
  Inbox,
  Loader2,
  LogOut,
  Plus,
  Search,
  Settings,
  Trash2,
  User,
} from "lucide-react"
import { useState } from "react"

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Label,
  MiniSparkline,
  Progress,
  ScrollArea,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ThemeSwitcher,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../src/components"
import { ThemeProvider } from "../src/hooks/useTheme"

interface SwatchProps {
  label: string
  variable: string
  description?: string
}

function Swatch({ label, variable, description }: SwatchProps) {
  return (
    <div className="space-y-2">
      <div
        className="h-16 rounded-lg border border-border"
        style={{ backgroundColor: `var(${variable})` }}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <code className="font-mono text-[11px] text-muted-foreground">{variable}</code>
      </div>
      {description ? (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
        {description ? (
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div>{children}</div>
    </div>
  )
}

const SPARKLINE_DATA = [3, 5, 4, 6, 5, 8, 7, 9, 8, 10].map((value, index) => ({
  value,
  timestamp: new Date(2026, 0, index + 1).toISOString(),
}))

const SAMPLE_DATA = [
  { id: "ds-001", name: "erp.customers", rows: 4_312, status: "synced", updated: "11m ago" },
  { id: "ds-002", name: "erp.invoices", rows: 12_904, status: "syncing", updated: "now" },
  { id: "ds-003", name: "erp.tasks", rows: 78_201, status: "failed", updated: "2h ago" },
  { id: "ds-004", name: "erp.projects", rows: 312, status: "synced", updated: "yesterday" },
]

const COMMAND_PREVIEW_IDLE_VALUE = "__pario_command_preview_idle__"

function Showcase() {
  const [search, setSearch] = useState("")
  const [collectionView, setCollectionView] = useState<"cards" | "table">("cards")
  const [progress, setProgress] = useState(64)
  const [airplane, setAirplane] = useState(false)
  const [agreed, setAgreed] = useState<boolean | "indeterminate">("indeterminate")

  return (
    <main className="min-h-dvh">
      <div className="mx-auto w-full max-w-6xl space-y-16 px-6 py-12 lg:px-10 lg:py-16">
        <header className="space-y-6">
          <div className="flex items-start justify-between gap-6">
            <div className="space-y-3">
              <Badge variant="outline" className="rounded-md">
                @pario/ui
              </Badge>
              <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-foreground sm:text-5xl">
                Pario design system
              </h1>
              <p className="max-w-2xl text-[15px] leading-7 text-muted-foreground">
                Shadcn-canonical primitives plus Pario&apos;s common components, restyled to a
                pure-white surface, hairline-border aesthetic. Add new primitives with{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">
                  bun ui:add &lt;name&gt;
                </code>
                .
              </p>
            </div>
            <div className="hidden shrink-0 flex-col items-end gap-2 lg:flex">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Theme
              </p>
              <ThemeSwitcher />
            </div>
          </div>
        </header>

        <Section
          title="Color"
          description="Neutral-first palette with one electric blue accent. Pure-white cards lift above a subtly tinted canvas."
        >
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Swatch label="Background" variable="--background" description="Page canvas." />
            <Swatch label="Card" variable="--card" description="Pure white surfaces." />
            <Swatch
              label="Primary"
              variable="--primary"
              description="CTAs, links, and focus rings."
            />
            <Swatch label="Foreground" variable="--foreground" description="Headings and body." />
            <Swatch label="Muted" variable="--muted" description="Filled inputs, badges." />
            <Swatch
              label="Muted foreground"
              variable="--muted-foreground"
              description="Captions, secondary labels."
            />
            <Swatch label="Border" variable="--border" description="Structural hairlines." />
          </div>
        </Section>

        <Section title="Buttons" description="Variants and sizes.">
          <Block label="Variants">
            <div className="flex flex-wrap items-center gap-2">
              <Button>Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="link">Link</Button>
              <Button variant="destructive">Destructive</Button>
            </div>
          </Block>
          <Block label="Sizes">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs">Extra small</Button>
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">Large</Button>
              <Button size="icon">
                <Plus />
              </Button>
              <Button variant="outline">
                <Plus /> With icon
              </Button>
            </div>
          </Block>
        </Section>

        <Section title="Badges" description="Status chips. Color = signal, not decoration.">
          <Block label="Variants">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="ghost">Ghost</Badge>
              <Badge variant="link">Link</Badge>
            </div>
          </Block>
        </Section>

        <Section
          title="Cards"
          description="Composable card primitive with header, content, action, and footer slots."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Acme Corp</CardTitle>
                <CardDescription>Local project · 34 objects</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                A connected acme-erp source materializing 10 datasets and 8 syncs.
              </CardContent>
              <CardFooter className="flex items-center justify-between">
                <Badge variant="secondary">
                  <CheckCircle2 className="h-3 w-3" /> Healthy
                </Badge>
                <Button size="sm" variant="outline">
                  Inspect
                </Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Erp Customers</CardTitle>
                <CardDescription>erp.customers — 4 rows · 7 cols</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <MiniSparkline data={SPARKLINE_DATA} width={140} height={32} />
                  <span className="font-mono text-foreground">+12.4%</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="Forms" description="Input, label, select, checkbox, switch.">
          <Card>
            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Project name</Label>
                  <Input id="name" placeholder="acme-corp" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="env">Environment</Label>
                  <Select defaultValue="local">
                    <SelectTrigger id="env">
                      <SelectValue placeholder="Select environment" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Environments</SelectLabel>
                        <SelectItem value="local">Local</SelectItem>
                        <SelectItem value="staging">Staging</SelectItem>
                        <SelectItem value="production">Production</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-2">
                  <Switch id="airplane" checked={airplane} onCheckedChange={setAirplane} />
                  <Label htmlFor="airplane" className="cursor-pointer">
                    Sync on save
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id="agreed" checked={agreed} onCheckedChange={setAgreed} />
                  <Label htmlFor="agreed" className="cursor-pointer">
                    I agree to overwrite existing rows
                  </Label>
                </div>
              </div>
            </CardContent>
          </Card>
        </Section>

        <Section title="Search & Command">
          <div className="grid gap-4 lg:grid-cols-2">
            <Block label="Search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search datasets, columns, syncs…"
                  className="pl-9"
                />
              </div>
            </Block>
            <Block label="Command palette">
              <Command
                className="rounded-md border border-border"
                defaultValue={COMMAND_PREVIEW_IDLE_VALUE}
              >
                <CommandInput placeholder="Type a command or search…" />
                <CommandList>
                  <CommandEmpty>No results found.</CommandEmpty>
                  <CommandGroup heading="Suggestions">
                    <CommandItem>
                      <Calendar /> Calendar
                    </CommandItem>
                    <CommandItem>
                      <Search /> Search
                    </CommandItem>
                    <CommandItem>
                      <Settings /> Settings
                    </CommandItem>
                  </CommandGroup>
                  <CommandSeparator />
                  <CommandGroup heading="Project">
                    <CommandItem>
                      <Folder /> Open project
                    </CommandItem>
                    <CommandItem>
                      <GitBranch /> Switch branch
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </Block>
          </div>
        </Section>

        <Section title="Tabs">
          <div className="grid gap-4 lg:grid-cols-2">
            <Block label="Default (segmented)">
              <Tabs defaultValue="overview">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="schema">Schema</TabsTrigger>
                  <TabsTrigger value="runs">Runs</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="pt-3 text-sm text-muted-foreground">
                  Overview content.
                </TabsContent>
              </Tabs>
            </Block>
            <Block label="Line">
              <Tabs defaultValue="props">
                <TabsList variant="line">
                  <TabsTrigger value="props">Properties</TabsTrigger>
                  <TabsTrigger value="links">Links</TabsTrigger>
                  <TabsTrigger value="actions">Actions</TabsTrigger>
                </TabsList>
                <TabsContent value="props" className="pt-3 text-sm text-muted-foreground">
                  Property list…
                </TabsContent>
              </Tabs>
            </Block>
          </div>
        </Section>

        <Section title="Tables" description="Plain table primitive.">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dataset</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SAMPLE_DATA.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-foreground">{row.name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={row.status === "failed" ? "destructive" : "secondary"}
                        className="font-mono text-[10px] uppercase tracking-wider"
                      >
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {row.rows.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {row.updated}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>

        <Section title="Progress & Skeleton">
          <div className="grid gap-4 lg:grid-cols-2">
            <Block label="Progress">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Indexing</span>
                  <span className="font-mono text-foreground">{progress}%</span>
                </div>
                <Progress value={progress} />
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setProgress((p) => Math.max(0, p - 10))}
                  >
                    −10
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setProgress((p) => Math.min(100, p + 10))}
                  >
                    +10
                  </Button>
                </div>
              </div>
            </Block>
            <Block label="Skeleton">
              <div className="space-y-3">
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </Block>
          </div>
        </Section>

        <Section title="Avatar & Alert">
          <div className="grid gap-4 lg:grid-cols-2">
            <Block label="Avatars">
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
                  <AvatarFallback>SH</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>AD</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>
                    <User className="h-4 w-4" />
                  </AvatarFallback>
                </Avatar>
              </div>
            </Block>
            <Block label="Alert">
              <Alert>
                <Bell />
                <AlertTitle>Heads up.</AlertTitle>
                <AlertDescription>This is a non-blocking notification component.</AlertDescription>
              </Alert>
            </Block>
          </div>
        </Section>

        <Section title="Dialog, Sheet, Dropdown & Tooltip">
          <Block label="Floating UI">
            <TooltipProvider>
              <div className="flex flex-wrap items-center gap-3">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">Open dialog</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Delete dataset</DialogTitle>
                      <DialogDescription>
                        This permanently removes erp.customers and all its sync history.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                      </DialogClose>
                      <Button variant="destructive">
                        <Trash2 /> Delete
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline">
                      <Filter /> Open sheet
                    </Button>
                  </SheetTrigger>
                  <SheetContent>
                    <SheetHeader>
                      <SheetTitle>Filters</SheetTitle>
                      <SheetDescription>Refine the dataset view.</SheetDescription>
                    </SheetHeader>
                    <div className="space-y-3 px-4 pb-4 text-sm text-muted-foreground">
                      A sheet is a side-mounted panel for secondary controls.
                    </div>
                  </SheetContent>
                </Sheet>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline">
                      <Cog /> Open menu
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Project</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>Rename</DropdownMenuItem>
                    <DropdownMenuItem>Duplicate</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive">
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon">
                      <Bell />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>You have 3 new alerts</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          </Block>
        </Section>

        <Section title="Sidebar" description="Full-app sidebar primitive (shadcn).">
          <Card className="overflow-hidden p-0">
            <SidebarProvider className="!min-h-0">
              <div className="flex h-[420px] w-full">
                <Sidebar collapsible="none" className="!w-56 border-r border-border">
                  <SidebarHeader className="px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      acme-corp
                    </p>
                  </SidebarHeader>
                  <SidebarContent>
                    <SidebarGroup>
                      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
                      <SidebarGroupContent>
                        <SidebarMenu>
                          {[
                            { icon: Home, label: "Home", active: true },
                            { icon: Database, label: "Datasets" },
                            { icon: Inbox, label: "Inbox" },
                            { icon: GitBranch, label: "Pipelines" },
                          ].map((item) => (
                            <SidebarMenuItem key={item.label}>
                              <SidebarMenuButton isActive={item.active}>
                                <item.icon />
                                <span>{item.label}</span>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          ))}
                        </SidebarMenu>
                      </SidebarGroupContent>
                    </SidebarGroup>
                  </SidebarContent>
                  <SidebarFooter className="px-3 py-3">
                    <Button variant="ghost" size="sm" className="justify-start">
                      <LogOut /> Sign out
                    </Button>
                  </SidebarFooter>
                </Sidebar>
                <SidebarInset className="bg-card">
                  <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                    <SidebarTrigger />
                    <p className="text-sm font-medium">Home</p>
                  </div>
                  <div className="p-6 text-sm text-muted-foreground">Sidebar content panel.</div>
                </SidebarInset>
              </div>
            </SidebarProvider>
          </Card>
        </Section>

        <Section title="Collection view (Pario)">
          <Card className="p-6">
            <div className="space-y-4">
              <CollectionHeader
                title="Datasets"
                count={SAMPLE_DATA.length}
                actions={
                  <CollectionViewToggle
                    value={collectionView}
                    onChange={setCollectionView}
                    options={[
                      { value: "cards", label: "Cards" },
                      { value: "table", label: "Table" },
                    ]}
                  />
                }
              />

              {collectionView === "cards" ? (
                <CollectionCardGrid>
                  {SAMPLE_DATA.map((d, index) => (
                    <CollectionCardButton key={d.id} onClick={() => {}} active={index === 0}>
                      <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{d.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {d.rows.toLocaleString()} rows · {d.updated}
                        </p>
                      </div>
                    </CollectionCardButton>
                  ))}
                </CollectionCardGrid>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dataset</TableHead>
                      <TableHead className="text-right">Rows</TableHead>
                      <TableHead className="text-right">Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {SAMPLE_DATA.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-mono">{d.name}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          {d.rows.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {d.updated}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </Card>
        </Section>

        <Section title="Empty state">
          <Block label="Default">
            <EmptyState
              icon={<Box className="size-12 stroke-1" />}
              title="No datasets yet"
              description="Connect a source to materialize datasets into your project."
              action={
                <Button size="sm">
                  <Plus /> Connect source
                </Button>
              }
            />
          </Block>
        </Section>

        <Section title="ScrollArea, separator, loaders">
          <div className="grid gap-4 lg:grid-cols-2">
            <Block label="ScrollArea">
              <ScrollArea className="h-32 rounded-md border border-border bg-card p-3">
                <ul className="space-y-1 text-sm text-foreground">
                  {Array.from({ length: 24 }, (_, index) => (
                    <li key={index} className="font-mono">
                      row_{String(index + 1).padStart(2, "0")}
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </Block>
            <Block label="Separator + Loader">
              <div className="space-y-3">
                <div className="flex items-center gap-3 text-sm text-foreground">
                  <span>Left</span>
                  <Separator orientation="vertical" className="h-4" />
                  <span className="text-muted-foreground">Right</span>
                </div>
                <Separator />
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            </Block>
          </div>
        </Section>

        <Section title="Theme switcher">
          <Block label="Inline">
            <ThemeSwitcher />
          </Block>
        </Section>
      </div>
    </main>
  )
}

export function PreviewApp() {
  return (
    <ThemeProvider>
      <Showcase />
    </ThemeProvider>
  )
}
