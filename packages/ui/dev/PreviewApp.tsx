import {
  Bell,
  Box,
  Calendar as CalendarIcon,
  CheckCircle2,
  ChevronRight,
  Cog,
  CreditCard,
  Database,
  FileText,
  Filter,
  Folder,
  GitBranch,
  GripVertical,
  Home,
  Inbox,
  KeyRound,
  Layers,
  Loader2,
  LogOut,
  Mail,
  PanelTop,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquareStack,
  Terminal,
  Trash2,
  Upload,
  User,
} from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  XAxis,
  YAxis,
} from "recharts"
import { toast } from "sonner"
import type { ChartConfig } from "../src/components"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  AspectRatio,
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
  Button,
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
  Calendar,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  Combobox,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DirectionProvider,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyState,
  EmptyTitle,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
  Kbd,
  KbdGroup,
  Label,
  Marker,
  MarkerContent,
  MarkerIcon,
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MiniSparkline,
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  RadioGroup,
  RadioGroupItem,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
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
  Slider,
  Spinner,
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
  Textarea,
  ThemeSwitcher,
  Toaster,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
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

function Specimen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div>{children}</div>
    </div>
  )
}

function ChartPreviewCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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

const CHART_SERIES_DATA = [
  { month: "Jan", desktop: 186, mobile: 80 },
  { month: "Feb", desktop: 305, mobile: 200 },
  { month: "Mar", desktop: 237, mobile: 120 },
  { month: "Apr", desktop: 73, mobile: 190 },
  { month: "May", desktop: 209, mobile: 130 },
  { month: "Jun", desktop: 214, mobile: 140 },
]

const USER_CHART_CONFIG = {
  desktop: {
    label: "Desktop",
    color: "var(--chart-1)",
  },
  mobile: {
    label: "Mobile",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig

const DEVICE_CHART_DATA = [
  { device: "desktop", visitors: 1260, fill: "var(--color-desktop)" },
  { device: "mobile", visitors: 1040, fill: "var(--color-mobile)" },
  { device: "tablet", visitors: 420, fill: "var(--color-tablet)" },
  { device: "other", visitors: 180, fill: "var(--color-other)" },
]

const DEVICE_CHART_CONFIG = {
  visitors: {
    label: "Visitors",
  },
  desktop: {
    label: "Desktop",
    color: "var(--chart-1)",
  },
  mobile: {
    label: "Mobile",
    color: "var(--chart-3)",
  },
  tablet: {
    label: "Tablet",
    color: "var(--chart-4)",
  },
  other: {
    label: "Other",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

const RADAR_CHART_DATA = [
  { subject: "Schema", current: 92, target: 84 },
  { subject: "Sync", current: 78, target: 90 },
  { subject: "Actions", current: 86, target: 82 },
  { subject: "Rules", current: 67, target: 76 },
  { subject: "Search", current: 88, target: 74 },
  { subject: "Auth", current: 72, target: 88 },
]

const RADAR_CHART_CONFIG = {
  current: {
    label: "Current",
    color: "var(--chart-1)",
  },
  target: {
    label: "Target",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

const RADIAL_CHART_DATA = [
  { name: "complete", value: 74, fill: "var(--color-complete)" },
  { name: "running", value: 48, fill: "var(--color-running)" },
  { name: "queued", value: 31, fill: "var(--color-queued)" },
]

const RADIAL_CHART_CONFIG = {
  complete: {
    label: "Complete",
    color: "var(--chart-3)",
  },
  running: {
    label: "Running",
    color: "var(--chart-1)",
  },
  queued: {
    label: "Queued",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig

const COMMAND_PREVIEW_IDLE_VALUE = "__sixb_command_preview_idle__"

const BUBBLE_VARIANTS = [
  { variant: "default", label: "Default" },
  { variant: "secondary", label: "Secondary" },
  { variant: "tinted", label: "Tinted" },
  { variant: "muted", label: "Muted" },
  { variant: "outline", label: "Outline" },
  { variant: "ghost", label: "Ghost" },
  { variant: "destructive", label: "Destructive" },
] as const

function Showcase() {
  const [search, setSearch] = useState("")
  const [dataset, setDataset] = useState("erp.customers")
  const [collectionView, setCollectionView] = useState<"cards" | "table">("cards")
  const [progress, setProgress] = useState(64)
  const [airplane, setAirplane] = useState(false)
  const [agreed, setAgreed] = useState<boolean | "indeterminate">("indeterminate")
  const [calendarDate, setCalendarDate] = useState<Date | undefined>(new Date(2026, 5, 19))
  const form = useForm({
    defaultValues: {
      email: "ops@sixb.dev",
    },
  })

  return (
    <main className="min-h-dvh">
      <div className="mx-auto w-full max-w-6xl space-y-16 px-6 py-12 lg:px-10 lg:py-16">
        <header className="space-y-6">
          <div className="flex items-start justify-between gap-6">
            <div className="space-y-3">
              <Badge variant="outline" className="rounded-md">
                @sixb/ui
              </Badge>
              <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-foreground sm:text-5xl">
                Sixb design system
              </h1>
              <p className="max-w-2xl text-[15px] leading-7 text-muted-foreground">
                Shadcn-canonical primitives plus Sixb&apos;s common components, restyled to a
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
          description="Neutral-first palette with pure-white surfaces, black primary actions, and grey chart tokens."
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
          <Block label="Toggle controls">
            <div className="flex flex-wrap items-center gap-3">
              <Toggle variant="outline" aria-label="Pin project">
                <Sparkles /> Pin
              </Toggle>
              <ToggleGroup type="multiple" variant="outline" defaultValue={["schema"]}>
                <ToggleGroupItem value="schema">Schema</ToggleGroupItem>
                <ToggleGroupItem value="runs">Runs</ToggleGroupItem>
                <ToggleGroupItem value="logs">Logs</ToggleGroupItem>
              </ToggleGroup>
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
          title="Agents Chat"
          description="Conversation primitives composed into a live agent thread, with the bubble and attachment variant sets shown alongside."
        >
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(19rem,1fr)]">
            <Card className="gap-0 overflow-hidden p-0">
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Sparkles className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">invoices-analysis</p>
                  <p className="truncate text-xs text-muted-foreground">Agent run · 6 steps</p>
                </div>
                <Badge variant="secondary" className="gap-1.5">
                  <span className="size-1.5 animate-pulse rounded-full bg-foreground/60" />
                  Streaming
                </Badge>
              </div>

              <MessageScrollerProvider autoScroll defaultScrollPosition="end">
                <MessageScroller className="h-[440px] bg-card">
                  <MessageScrollerViewport>
                    <MessageScrollerContent className="p-4">
                      <MessageScrollerItem messageId="thread-start" scrollAnchor>
                        <Marker variant="separator">
                          <MarkerContent>Run started · 2:14 PM</MarkerContent>
                        </Marker>
                      </MessageScrollerItem>

                      <MessageScrollerItem messageId="user-request" scrollAnchor>
                        <BubbleGroup className="items-end">
                          <Bubble align="end">
                            <BubbleContent>
                              Check the latest invoice sync and tell me which accounts need review.
                            </BubbleContent>
                          </Bubble>
                        </BubbleGroup>
                      </MessageScrollerItem>

                      <MessageScrollerItem messageId="step-inspect" scrollAnchor>
                        <Marker>
                          <MarkerIcon>
                            <CheckCircle2 />
                          </MarkerIcon>
                          <MarkerContent>
                            Inspected the latest sync · compared 12,904 rows
                          </MarkerContent>
                        </Marker>
                      </MessageScrollerItem>

                      <MessageScrollerItem messageId="assistant-plan" scrollAnchor>
                        <BubbleGroup>
                          <Bubble variant="secondary">
                            <BubbleContent>
                              I grouped the failed rows by owner. Two accounts need a manual check
                              before the next projection run.
                            </BubbleContent>
                            <BubbleReactions>✓ 2</BubbleReactions>
                          </Bubble>
                        </BubbleGroup>
                      </MessageScrollerItem>

                      <MessageScrollerItem messageId="attachments" scrollAnchor>
                        <AttachmentGroup>
                          <Attachment state="done">
                            <AttachmentMedia>
                              <FileText />
                            </AttachmentMedia>
                            <AttachmentContent>
                              <AttachmentTitle>invoice-review.csv</AttachmentTitle>
                              <AttachmentDescription>18 KB · generated now</AttachmentDescription>
                            </AttachmentContent>
                            <AttachmentActions>
                              <AttachmentAction aria-label="Remove invoice review">
                                <Trash2 />
                              </AttachmentAction>
                            </AttachmentActions>
                            <AttachmentTrigger aria-label="Open invoice review attachment" />
                          </Attachment>

                          <Attachment state="processing">
                            <AttachmentMedia>
                              <Spinner />
                            </AttachmentMedia>
                            <AttachmentContent>
                              <AttachmentTitle>owner-summary.md</AttachmentTitle>
                              <AttachmentDescription>Preparing preview</AttachmentDescription>
                            </AttachmentContent>
                          </Attachment>
                        </AttachmentGroup>
                      </MessageScrollerItem>

                      <MessageScrollerItem messageId="assistant-status" scrollAnchor>
                        <Marker role="status">
                          <MarkerIcon>
                            <Spinner />
                          </MarkerIcon>
                          <MarkerContent className="shimmer text-muted-foreground">
                            Generating response...
                          </MarkerContent>
                        </Marker>
                      </MessageScrollerItem>
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton />
                </MessageScroller>
              </MessageScrollerProvider>
            </Card>

            <Card className="gap-0 divide-y divide-border p-0">
              <Specimen label="Bubble variants">
                <div className="flex flex-col gap-2">
                  {BUBBLE_VARIANTS.map(({ variant, label }) => (
                    <Bubble key={variant} variant={variant}>
                      <BubbleContent>{label}</BubbleContent>
                    </Bubble>
                  ))}
                </div>
              </Specimen>

              <Specimen label="Attachment states">
                <div className="flex flex-col gap-2">
                  <Attachment size="sm" state="idle" className="w-full max-w-full">
                    <AttachmentMedia>
                      <Upload />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>drop-files</AttachmentTitle>
                      <AttachmentDescription>Waiting</AttachmentDescription>
                    </AttachmentContent>
                  </Attachment>
                  <Attachment size="sm" state="uploading" className="w-full max-w-full">
                    <AttachmentMedia>
                      <Spinner />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>sync-output.csv</AttachmentTitle>
                      <AttachmentDescription>Uploading 42%</AttachmentDescription>
                    </AttachmentContent>
                  </Attachment>
                  <Attachment size="sm" state="processing" className="w-full max-w-full">
                    <AttachmentMedia>
                      <Spinner />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>owner-summary.md</AttachmentTitle>
                      <AttachmentDescription>Preparing preview</AttachmentDescription>
                    </AttachmentContent>
                  </Attachment>
                  <Attachment size="sm" state="error" className="w-full max-w-full">
                    <AttachmentMedia>
                      <FileText />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>stale-export.json</AttachmentTitle>
                      <AttachmentDescription>Permission denied</AttachmentDescription>
                    </AttachmentContent>
                  </Attachment>
                  <Attachment size="sm" state="done" className="w-full max-w-full">
                    <AttachmentMedia>
                      <CheckCircle2 />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>run-report.pdf</AttachmentTitle>
                      <AttachmentDescription>Ready</AttachmentDescription>
                    </AttachmentContent>
                  </Attachment>
                </div>
              </Specimen>
            </Card>
          </div>
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

        <Section
          title="Charts"
          description="Shadcn chart primitives backed by Recharts, using the shared chart color tokens."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartPreviewCard
              title="Area Chart"
              description="Opacity-differentiated stacked series."
            >
              <ChartContainer config={USER_CHART_CONFIG} className="h-[240px] w-full">
                <AreaChart
                  accessibilityLayer
                  data={CHART_SERIES_DATA}
                  margin={{ left: 12, right: 12 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis hide />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Area
                    dataKey="mobile"
                    type="monotone"
                    fill="var(--color-mobile)"
                    fillOpacity={0.22}
                    stroke="var(--color-mobile)"
                    stackId="a"
                  />
                  <Area
                    dataKey="desktop"
                    type="monotone"
                    fill="var(--color-desktop)"
                    fillOpacity={0.18}
                    stroke="var(--color-desktop)"
                    stackId="a"
                  />
                </AreaChart>
              </ChartContainer>
            </ChartPreviewCard>

            <ChartPreviewCard title="Bar Chart" description="Grouped bars with tokenized fills.">
              <ChartContainer config={USER_CHART_CONFIG} className="h-[240px] w-full">
                <BarChart
                  accessibilityLayer
                  data={CHART_SERIES_DATA}
                  margin={{ left: 12, right: 12 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis hide />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="desktop" fill="var(--color-desktop)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="mobile" fill="var(--color-mobile)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </ChartPreviewCard>

            <ChartPreviewCard
              title="Line Chart"
              description="Solid and dashed series with line tooltip."
            >
              <ChartContainer config={USER_CHART_CONFIG} className="h-[240px] w-full">
                <LineChart
                  accessibilityLayer
                  data={CHART_SERIES_DATA}
                  margin={{ left: 12, right: 12 }}
                >
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis hide />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line
                    dataKey="desktop"
                    type="monotone"
                    stroke="var(--color-desktop)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    dataKey="mobile"
                    type="monotone"
                    stroke="var(--color-mobile)"
                    strokeDasharray="4 4"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            </ChartPreviewCard>

            <ChartPreviewCard
              title="Pie Chart"
              description="Segment colors are driven by the chart config."
            >
              <ChartContainer config={DEVICE_CHART_CONFIG} className="h-[240px] w-full">
                <PieChart accessibilityLayer>
                  <ChartTooltip
                    cursor={false}
                    content={<ChartTooltipContent hideLabel nameKey="device" />}
                  />
                  <Pie
                    data={DEVICE_CHART_DATA}
                    dataKey="visitors"
                    nameKey="device"
                    innerRadius={54}
                    outerRadius={88}
                    strokeWidth={0}
                  />
                  <ChartLegend content={<ChartLegendContent nameKey="device" />} />
                </PieChart>
              </ChartContainer>
            </ChartPreviewCard>

            <ChartPreviewCard
              title="Radar Chart"
              description="Filled current area with a dashed target outline."
            >
              <ChartContainer config={RADAR_CHART_CONFIG} className="h-[260px] w-full">
                <RadarChart accessibilityLayer data={RADAR_CHART_DATA}>
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <PolarGrid />
                  <PolarAngleAxis dataKey="subject" tick={{ fontSize: 11 }} />
                  <Radar
                    dataKey="current"
                    fill="var(--color-current)"
                    fillOpacity={0.22}
                    stroke="var(--color-current)"
                    strokeWidth={2}
                  />
                  <Radar
                    dataKey="target"
                    fill="var(--color-target)"
                    fillOpacity={0}
                    stroke="var(--color-target)"
                    strokeDasharray="4 4"
                    strokeWidth={2}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </RadarChart>
              </ChartContainer>
            </ChartPreviewCard>

            <ChartPreviewCard title="Radial Chart" description="Multi-ring status chart.">
              <ChartContainer config={RADIAL_CHART_CONFIG} className="h-[260px] w-full">
                <RadialBarChart
                  accessibilityLayer
                  data={RADIAL_CHART_DATA}
                  innerRadius={36}
                  outerRadius={108}
                  startAngle={90}
                  endAngle={-270}
                >
                  <ChartTooltip
                    cursor={false}
                    content={<ChartTooltipContent hideLabel nameKey="name" />}
                  />
                  <RadialBar dataKey="value" background cornerRadius={8} />
                  <ChartLegend content={<ChartLegendContent nameKey="name" />} />
                </RadialBarChart>
              </ChartContainer>
            </ChartPreviewCard>
          </div>
        </Section>

        <Section title="Forms" description="Input, textarea, label, select, checkbox, switch.">
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
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="notes">Notes</Label>
                  <Textarea
                    id="notes"
                    rows={3}
                    placeholder="Reviewer context, rollout caveats..."
                  />
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

        <Section
          title="Form Composition"
          description="Field, form, and advanced input primitives for dense app workflows."
        >
          <div className="grid gap-4 xl:grid-cols-2">
            <Block label="Form + field">
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit((values) => {
                    toast.success(`Saved ${values.email}`)
                  })}
                  className="space-y-5"
                >
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Owner email</FormLabel>
                        <FormControl>
                          <InputGroup>
                            <InputGroupAddon>
                              <Mail />
                            </InputGroupAddon>
                            <InputGroupInput placeholder="ops@sixb.dev" {...field} />
                          </InputGroup>
                        </FormControl>
                        <FormDescription>
                          Used for run notifications and audit exports.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FieldSeparator className="my-3">Policy</FieldSeparator>

                  <FieldSet className="gap-5">
                    <FieldLegend variant="label">Write controls</FieldLegend>
                    <FieldGroup>
                      <Field orientation="horizontal">
                        <Switch id="field-audit" defaultChecked />
                        <FieldContent>
                          <FieldLabel htmlFor="field-audit">Require audit log</FieldLabel>
                          <FieldDescription>
                            Record every mutation made by preview actions.
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                      <Field>
                        <FieldTitle>Conflict policy</FieldTitle>
                        <FieldDescription>
                          Choose how local writes behave when upstream data changes.
                        </FieldDescription>
                        <RadioGroup defaultValue="review" className="grid gap-2 sm:grid-cols-3">
                          {["review", "queue", "block"].map((value) => (
                            <div key={value} className="flex items-center gap-2">
                              <RadioGroupItem id={`policy-${value}`} value={value} />
                              <Label htmlFor={`policy-${value}`} className="capitalize">
                                {value}
                              </Label>
                            </div>
                          ))}
                        </RadioGroup>
                      </Field>
                    </FieldGroup>
                  </FieldSet>

                  <Button size="sm" type="submit">
                    Save owner
                  </Button>
                </form>
              </Form>
            </Block>

            <Block label="Inputs">
              <div className="grid gap-6">
                <InputGroup>
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  <InputGroupInput placeholder="Find datasets" />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton>
                      <Upload />
                      Import
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>

                <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(13rem,0.6fr)]">
                  <div className="space-y-2">
                    <Label>Dataset</Label>
                    <Combobox
                      value={dataset}
                      onValueChange={setDataset}
                      options={SAMPLE_DATA.map((row) => ({
                        value: row.name,
                        label: row.name,
                        description: row.status,
                      }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Native select</Label>
                    <NativeSelect defaultValue="staging">
                      <NativeSelectOptGroup label="Deploy targets">
                        <NativeSelectOption value="local">Local</NativeSelectOption>
                        <NativeSelectOption value="staging">Staging</NativeSelectOption>
                        <NativeSelectOption value="production">Production</NativeSelectOption>
                      </NativeSelectOptGroup>
                    </NativeSelect>
                  </div>
                </div>

                <div className="grid gap-5 md:grid-cols-[max-content_minmax(12rem,1fr)] md:items-start">
                  <div className="space-y-2">
                    <Label>One-time code</Label>
                    <InputOTP maxLength={6} defaultValue="204800">
                      <InputOTPGroup>
                        <InputOTPSlot index={0} />
                        <InputOTPSlot index={1} />
                        <InputOTPSlot index={2} />
                      </InputOTPGroup>
                      <InputOTPSeparator />
                      <InputOTPGroup>
                        <InputOTPSlot index={3} />
                        <InputOTPSlot index={4} />
                        <InputOTPSlot index={5} />
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  <div className="min-w-0 space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <Label>Batch size</Label>
                      <span className="font-mono text-muted-foreground">64%</span>
                    </div>
                    <Slider defaultValue={[64]} max={100} step={1} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Quick actions</Label>
                  <ButtonGroup>
                    <Button variant="outline">Run</Button>
                    <Button variant="outline">Queue</Button>
                    <ButtonGroupSeparator />
                    <ButtonGroupText>
                      <KbdGroup>
                        <Kbd>Cmd</Kbd>
                        <Kbd>K</Kbd>
                      </KbdGroup>
                    </ButtonGroupText>
                  </ButtonGroup>
                </div>
              </div>
            </Block>

            <Block label="Calendar">
              <Calendar
                mode="single"
                selected={calendarDate}
                onSelect={(date) => setCalendarDate(date)}
                className="rounded-md border border-border"
              />
            </Block>
          </div>
        </Section>

        <Section
          title="Navigation & Disclosure"
          description="Breadcrumb, navigation menu, accordion, collapsible, pagination, and direction primitives."
        >
          <div className="grid gap-4 xl:grid-cols-2">
            <Block label="Navigation menu">
              <div className="space-y-5">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <BreadcrumbLink href="#">Projects</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator>
                      <ChevronRight />
                    </BreadcrumbSeparator>
                    <BreadcrumbItem>
                      <BreadcrumbEllipsis />
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>acme-corp</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>

                <NavigationMenu viewport={false}>
                  <NavigationMenuList>
                    <NavigationMenuItem>
                      <NavigationMenuTrigger>Platform</NavigationMenuTrigger>
                      <NavigationMenuContent>
                        <div className="grid w-72 gap-1 p-1">
                          <NavigationMenuLink href="#">
                            <Layers />
                            <span className="font-medium">Objects</span>
                            <span className="text-muted-foreground">Typed runtime entities.</span>
                          </NavigationMenuLink>
                          <NavigationMenuLink href="#">
                            <GitBranch />
                            <span className="font-medium">Pipelines</span>
                            <span className="text-muted-foreground">Sync and transform flows.</span>
                          </NavigationMenuLink>
                        </div>
                      </NavigationMenuContent>
                    </NavigationMenuItem>
                    <NavigationMenuItem>
                      <NavigationMenuLink href="#" className="h-9 justify-center px-4">
                        Docs
                      </NavigationMenuLink>
                    </NavigationMenuItem>
                  </NavigationMenuList>
                </NavigationMenu>
              </div>
            </Block>

            <Block label="Accordion + collapsible">
              <div className="space-y-4">
                <Accordion type="single" collapsible defaultValue="schema">
                  <AccordionItem value="schema">
                    <AccordionTrigger>Schema changes</AccordionTrigger>
                    <AccordionContent>
                      Three object types and two action handlers were regenerated.
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="sync">
                    <AccordionTrigger>Sync status</AccordionTrigger>
                    <AccordionContent>
                      Last successful run finished 11 minutes ago.
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>

                <Collapsible defaultOpen className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">Advanced filters</p>
                      <p className="text-xs text-muted-foreground">Expanded by default.</p>
                    </div>
                    <CollapsibleTrigger asChild>
                      <Button size="sm" variant="ghost">
                        Toggle
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="pt-3 text-sm text-muted-foreground">
                    Owner, status, branch, and runtime filters.
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </Block>

            <Block label="Pagination">
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious href="#" />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLink href="#" isActive>
                      1
                    </PaginationLink>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLink href="#">2</PaginationLink>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext href="#" />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </Block>

            <Block label="Direction">
              <DirectionProvider dir="rtl">
                <div dir="rtl" className="rounded-md border border-border p-3">
                  <Breadcrumb>
                    <BreadcrumbList>
                      <BreadcrumbItem>
                        <BreadcrumbLink href="#">البيانات</BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbPage>المزامنة</BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
              </DirectionProvider>
            </Block>
          </div>
        </Section>

        <Section
          title="Media & Panels"
          description="Aspect ratio, carousel, resizable panels, and item lists."
        >
          <div className="grid gap-4 xl:grid-cols-2">
            <Block label="Aspect ratio">
              <AspectRatio
                ratio={16 / 9}
                className="overflow-hidden rounded-md border border-border"
              >
                <div className="flex h-full w-full flex-col justify-between bg-muted p-4">
                  <PanelTop className="size-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Preview surface</p>
                    <p className="text-xs text-muted-foreground">Stable 16:9 frame.</p>
                  </div>
                </div>
              </AspectRatio>
            </Block>

            <Block label="Carousel">
              <Carousel className="mx-10">
                <CarouselContent>
                  {["Objects", "Syncs", "Actions"].map((label, index) => (
                    <CarouselItem key={label} className="basis-2/3">
                      <div className="flex aspect-[4/3] flex-col justify-between rounded-md border border-border bg-muted p-4">
                        <SquareStack className="size-5 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{label}</p>
                          <p className="font-mono text-xs text-muted-foreground">0{index + 1}</p>
                        </div>
                      </div>
                    </CarouselItem>
                  ))}
                </CarouselContent>
                <CarouselPrevious />
                <CarouselNext />
              </Carousel>
            </Block>

            <Block label="Resizable">
              <ResizablePanelGroup
                orientation="horizontal"
                className="min-h-44 rounded-md border border-border"
              >
                <ResizablePanel defaultSize={45} minSize={30}>
                  <div className="flex h-full items-center justify-center gap-2 p-4 text-sm">
                    <FileText className="size-4 text-muted-foreground" />
                    Schema
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={55} minSize={30}>
                  <div className="flex h-full items-center justify-center gap-2 p-4 text-sm">
                    <GripVertical className="size-4 text-muted-foreground" />
                    Inspector
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            </Block>

            <Block label="Items">
              <ItemGroup>
                {SAMPLE_DATA.slice(0, 3).map((row, index) => (
                  <div key={row.id}>
                    <Item variant={index === 0 ? "outline" : "default"}>
                      <ItemMedia variant="icon">
                        <Database />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{row.name}</ItemTitle>
                        <ItemDescription>
                          {row.rows.toLocaleString()} rows updated {row.updated}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Badge variant={row.status === "failed" ? "destructive" : "secondary"}>
                          {row.status}
                        </Badge>
                      </ItemActions>
                    </Item>
                    {index < 2 ? <ItemSeparator /> : null}
                  </div>
                ))}
              </ItemGroup>
            </Block>
          </div>
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
                      <CalendarIcon /> Calendar
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

        <Section title="Overlays & Menus">
          <Block label="Floating UI">
            <TooltipProvider>
              <div className="space-y-4">
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

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline">
                        <KeyRound /> Alert dialog
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Rotate access keys?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Active syncs will pause until the new key is confirmed.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction>Rotate key</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

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

                  <Drawer>
                    <DrawerTrigger asChild>
                      <Button variant="outline">
                        <CreditCard /> Drawer
                      </Button>
                    </DrawerTrigger>
                    <DrawerContent>
                      <DrawerHeader>
                        <DrawerTitle>Billing checkpoint</DrawerTitle>
                        <DrawerDescription>
                          Bottom-mounted drawer for mobile-friendly confirmations.
                        </DrawerDescription>
                      </DrawerHeader>
                      <DrawerFooter>
                        <Button>Continue</Button>
                        <DrawerClose asChild>
                          <Button variant="outline">Cancel</Button>
                        </DrawerClose>
                      </DrawerFooter>
                    </DrawerContent>
                  </Drawer>

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

                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline">Open popover</Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72">
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Preview branch</p>
                        <p className="text-sm text-muted-foreground">
                          Popovers hold compact, contextual controls.
                        </p>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <Button variant="outline">Hover owner</Button>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-72">
                      <div className="flex gap-3">
                        <Avatar className="size-9">
                          <AvatarFallback>AD</AvatarFallback>
                        </Avatar>
                        <div className="space-y-1">
                          <p className="text-sm font-medium">Anthony</p>
                          <p className="text-sm text-muted-foreground">
                            Owns package review and release notes.
                          </p>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon">
                        <Bell />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>You have 3 new alerts</TooltipContent>
                  </Tooltip>
                </div>

                <Menubar>
                  <MenubarMenu>
                    <MenubarTrigger>Project</MenubarTrigger>
                    <MenubarContent>
                      <MenubarItem>
                        New sync <MenubarShortcut>Cmd+N</MenubarShortcut>
                      </MenubarItem>
                      <MenubarItem>Open logs</MenubarItem>
                      <MenubarSeparator />
                      <MenubarItem>Settings</MenubarItem>
                    </MenubarContent>
                  </MenubarMenu>
                  <MenubarMenu>
                    <MenubarTrigger>Run</MenubarTrigger>
                    <MenubarContent>
                      <MenubarItem>Start</MenubarItem>
                      <MenubarItem>Pause</MenubarItem>
                    </MenubarContent>
                  </MenubarMenu>
                </Menubar>

                <ContextMenu>
                  <ContextMenuTrigger className="flex h-24 items-center justify-center rounded-md border border-dashed border-border bg-muted text-sm text-muted-foreground">
                    Right click preview canvas
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuLabel>Canvas</ContextMenuLabel>
                    <ContextMenuItem>
                      <Terminal /> Open inspector
                      <ContextMenuShortcut>Cmd+I</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuCheckboxItem checked>Show grid</ContextMenuCheckboxItem>
                    <ContextMenuSeparator />
                    <ContextMenuRadioGroup value="compact">
                      <ContextMenuRadioItem value="compact">Compact</ContextMenuRadioItem>
                      <ContextMenuRadioItem value="comfortable">Comfortable</ContextMenuRadioItem>
                    </ContextMenuRadioGroup>
                  </ContextMenuContent>
                </ContextMenu>
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

        <Section title="Collection view (Sixb)">
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
          <div className="grid gap-4 lg:grid-cols-2">
            <Block label="Sixb empty state">
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
            <Block label="Shadcn empty">
              <Empty className="border border-border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Inbox />
                  </EmptyMedia>
                  <EmptyTitle>No review tasks</EmptyTitle>
                  <EmptyDescription>
                    Everything has been handled for the current preview branch.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button size="sm" variant="outline" onClick={() => toast.info("No review tasks")}>
                    Check again
                  </Button>
                </EmptyContent>
              </Empty>
            </Block>
          </div>
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
                <div className="flex items-center gap-3 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <Spinner />
                </div>
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
      <Toaster />
    </ThemeProvider>
  )
}
